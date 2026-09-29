/**
 * Read-only staleness + state gates for the explicit apply orchestrator
 * (ADR 2026-09-28 §2.3/§2.6/§2.10.5, ADR 2026-09-29 §2.3.4).
 *
 * Extracted from `placement-apply.service.ts` so that orchestrator stays under
 * the project's 350-line file convention once the triage branch was added.
 * Pure reads only — none of these functions touches the graph, so they also
 * serve the non-mutating dry-run.
 */

import type { Database } from 'bun:sqlite'
import { config } from '../config'
import {
  SYMMETRIC_EDGE_TYPES,
  getClusterMembers,
  getClusterThought,
  getEdgePairBetween,
  isValidEdgeType
} from '../db/edges'
import type { PlacementProposalRow } from '../db/placement-proposals'
import { getThoughtRow } from '../db/thoughts'
import type { ApplyOptions } from './placement-apply.types'
import { isProposalStale } from './placement-proposals.service'
import { isScheduledReminder } from './triage.service'

/** The (source, target, type) an edge-creating item would write, if any. */
export interface PlannedEdge {
  sourceId: string
  targetId: string
  type: string
}

export type Gate = { kind: 'ok' } | { kind: 'already_applied' } | { kind: 'stale'; reason: string } | { kind: 'failed'; reason: string }

/** Resolve the edge a proposal would create (ADR §2.5 / §2.6). */
export function plannedEdge(row: PlacementProposalRow, options: ApplyOptions): PlannedEdge | undefined {
  const targetId = row.target_id
  if (!targetId) return undefined
  if (row.item_kind === 'edge' && row.edge_type) {
    return { sourceId: row.source_thought_id, targetId, type: row.edge_type }
  }
  if (row.item_kind === 'placement') {
    // Cluster direction is FROM the cluster TO the member; a parent edge is
    // FROM the parent TO the analysed thought.
    if (row.edge_type === 'cluster') {
      return { sourceId: targetId, targetId: row.source_thought_id, type: 'cluster' }
    }
    return { sourceId: targetId, targetId: row.source_thought_id, type: options.edgeType ?? row.edge_type ?? 'parent' }
  }
  if (row.item_kind === 'lifecycle' && row.lifecycle_action === 'replaces+archive') {
    return { sourceId: row.source_thought_id, targetId, type: 'replaces' }
  }
  return undefined
}

/**
 * Staleness + state-dependent gates (ADR §2.3, §2.6, §2.10.5). Read-only, so it
 * can run for a dry-run too.
 */
export function evaluateGates(row: PlacementProposalRow, options: ApplyOptions, d: Database): Gate {
  const source = getThoughtRow(d, row.source_thought_id)
  if (!source) return { kind: 'stale', reason: 'source thought no longer exists' }
  const target = row.target_id ? getThoughtRow(d, row.target_id) : undefined
  if (row.target_id && !target) return { kind: 'stale', reason: 'target thought no longer exists' }

  // Triage kinds mutate a *draft* source, so they must be gated before the
  // active-source gate below, which would wrongly refuse every draft
  // (ADR 2026-09-29 §2.3.4).
  if (row.item_kind === 'triage_activate' || row.item_kind === 'triage_archive') {
    const archive = row.item_kind === 'triage_archive'
    if (source.is_cluster || source.is_profile) return { kind: 'failed', reason: 'cluster/profile thoughts cannot be triaged' }
    if (archive && source.status === 'archived') return { kind: 'already_applied' }
    if (source.status !== 'draft') {
      if (!archive && source.status === 'active') return { kind: 'already_applied' }
      return { kind: 'stale', reason: `source is '${source.status}', not draft` }
    }
    if (isScheduledReminder(source, options.now ?? new Date().toISOString())) {
      return { kind: 'stale', reason: 'source became a scheduled reminder since enqueue' }
    }
    if (archive) {
      if (target?.status === 'archived') return { kind: 'stale', reason: 'the target duplicate is archived' }
      if (target && target.status !== 'active') return { kind: 'stale', reason: `target is '${target.status}', not active` }
    }
    if (isProposalStale(row, d)) return { kind: 'stale', reason: 'the graph changed since the proposal was enqueued' }
    return { kind: 'ok' }
  }

  const edge = plannedEdge(row, options)
  if (edge && !isValidEdgeType(edge.type)) return { kind: 'failed', reason: `invalid edge type '${edge.type}'` }

  // Already-applied / conflict detection for edge-creating items (ADR §2.6).
  if (edge && target) {
    const existing = getEdgePairBetween(d, edge.sourceId, edge.targetId)
    if (existing && existing.type === edge.type) {
      if (SYMMETRIC_EDGE_TYPES.has(edge.type)) return { kind: 'already_applied' }
      if (existing.source_id === edge.sourceId && existing.target_id === edge.targetId) {
        return { kind: 'already_applied' }
      }
      return { kind: 'stale', reason: `a reverse '${edge.type}' edge already exists between the pair` }
    }
    // A `related` placeholder is upgraded transactionally by `createEdge`.
    if (existing && existing.type !== 'related') {
      return { kind: 'stale', reason: `the pair already holds a '${existing.type}' edge` }
    }
  }

  // Only active thoughts participate in a confirmed move (ADR §2.3).
  if (source.status !== 'active') return { kind: 'stale', reason: `source is '${source.status}', not active` }
  if (target && target.status !== 'active') return { kind: 'stale', reason: `target is '${target.status}', not active` }

  // Project isolation is state-dependent and re-checked at apply time.
  if (target && source.project_id && target.project_id && source.project_id !== target.project_id) {
    return { kind: 'stale', reason: 'source and target belong to different projects' }
  }

  // Cluster placement: re-check the live cap (#934/#928) and cluster shape.
  if (row.item_kind === 'placement' && row.edge_type === 'cluster' && row.target_id) {
    if (!getClusterThought(d, row.target_id)) {
      return { kind: 'failed', reason: `target '${row.target_id}' is not a cluster thought` }
    }
    const members = getClusterMembers(d, row.target_id).length
    if (members >= config.placement.maxClusterSize) {
      return { kind: 'stale', reason: `cluster '${row.target_id}' has ${members} members >= maxClusterSize ${config.placement.maxClusterSize}` }
    }
  }

  // Profile thoughts are persona material and must survive (issue #200).
  if (row.item_kind === 'lifecycle' && row.lifecycle_action === 'merge' && source.is_profile) {
    return { kind: 'failed', reason: 'cannot merge a profile thought away' }
  }
  if (row.item_kind === 'lifecycle' && row.lifecycle_action === 'replaces+archive' && target?.is_profile) {
    return { kind: 'failed', reason: 'profile thoughts cannot be archived' }
  }

  // Fingerprint: the snapshot changed in a way nothing above handled (ADR §2.3).
  if (isProposalStale(row, d)) {
    return { kind: 'stale', reason: 'the graph changed since the proposal was enqueued' }
  }
  return { kind: 'ok' }
}
