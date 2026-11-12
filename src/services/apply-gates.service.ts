import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { SYMMETRIC_EDGE_TYPES, getEdgePairBetween, isValidEdgeType } from '../db/edges'
import { getClusterMembers, getClusterThought } from '../db/cluster-edges'
import type { PlacementProposalRow } from '../db/placement-proposals'
import { getThoughtRow } from '../db/thoughts'
import type { ApplyOptions } from './placement-apply.types'
import { isProposalStale } from './placement-proposals.service'

export interface PlannedEdge {
  sourceId: string
  targetId: string
  type: string
}

export type Gate =
  | { kind: 'ok' }
  | { kind: 'already_applied' }
  | { kind: 'stale'; reason: string }
  | { kind: 'failed'; reason: string }

export function plannedEdge(row: PlacementProposalRow): PlannedEdge | undefined {
  const targetId = row.target_id
  if (!targetId) return undefined
  if (row.item_kind === 'edge' && row.edge_type) {
    return { sourceId: row.source_thought_id, targetId, type: row.edge_type }
  }
  return undefined
}

export function evaluateGates(row: PlacementProposalRow, options: ApplyOptions, d: Database): Gate {
  // TTL is authoritative and checked first: an overdue row must not be confirmed nor
  // recorded as an idempotent accept, which would inject a phantom run-manifest entry.
  const now = options.now ?? new Date().toISOString()
  if (row.expires_at !== null && row.expires_at < now) {
    return { kind: 'stale', reason: `proposal expired at ${row.expires_at}; re-enqueue it` }
  }

  const source = getThoughtRow(d, row.source_thought_id)
  if (!source) return { kind: 'stale', reason: 'source thought no longer exists' }
  const target = row.target_id ? getThoughtRow(d, row.target_id) : undefined
  if (row.target_id && !target) return { kind: 'stale', reason: 'target thought no longer exists' }

  const edge = plannedEdge(row)
  if (edge && !isValidEdgeType(edge.type))
    return { kind: 'failed', reason: `invalid edge type '${edge.type}'` }

  if (edge && target) {
    const existing = getEdgePairBetween(d, edge.sourceId, edge.targetId)
    if (existing && existing.type === edge.type) {
      if (SYMMETRIC_EDGE_TYPES.has(edge.type)) return { kind: 'already_applied' }
      if (existing.source_id === edge.sourceId && existing.target_id === edge.targetId) {
        return { kind: 'already_applied' }
      }
      return {
        kind: 'stale',
        reason: `a reverse '${edge.type}' edge already exists between the pair`
      }
    }
    // A `related` placeholder is upgraded in place by `createEdge`, so it is not a conflict.
    if (existing && existing.type !== 'related') {
      return { kind: 'stale', reason: `the pair already holds a '${existing.type}' edge` }
    }
  }

  if (source.status !== 'active')
    return { kind: 'stale', reason: `source is '${source.status}', not active` }
  if (target && target.status !== 'active')
    return { kind: 'stale', reason: `target is '${target.status}', not active` }

  if (target && source.project_id && target.project_id && source.project_id !== target.project_id) {
    return { kind: 'stale', reason: 'source and target belong to different projects' }
  }

  if (row.item_kind === 'edge' && row.edge_type === 'cluster' && row.target_id) {
    if (!getClusterThought(d, row.source_thought_id)) {
      return {
        kind: 'failed',
        reason: `source '${row.source_thought_id}' is not a cluster thought`
      }
    }
    const members = getClusterMembers(d, row.source_thought_id).length
    if (members >= config.placement.maxClusterSize) {
      return {
        kind: 'stale',
        reason: `cluster '${row.source_thought_id}' has ${members} members >= maxClusterSize ${config.placement.maxClusterSize}`
      }
    }
  }

  if (isProposalStale(row, d)) {
    return { kind: 'stale', reason: 'the graph changed since the proposal was enqueued' }
  }
  return { kind: 'ok' }
}
