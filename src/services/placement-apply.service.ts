/**
 * Explicit per-item `apply` for queued placement proposals (ADR 2026-09-28 P8,
 * §2.5–2.8 / R4).
 *
 * Thin orchestrator: it never writes the graph itself — every mutation
 * delegates to an existing writer (`createEdgeService`, `mergeThoughtsService`,
 * `archiveThoughtById`) inside the same transaction as the queue-state update,
 * so the graph and the queue cannot diverge (ADR §2.7). `confirm: false` (the
 * default) is a non-mutating dry-run; nothing ambient/scheduled calls `apply`.
 *
 * Conflict matrix (ADR §2.6): exact/symmetric duplicate → idempotent success;
 * reverse/different-type conflict, archived target, stale fingerprint, cluster
 * over `maxClusterSize` → `stale`; profile, invalid type, cluster constraint
 * violation → typed `failed`.
 */

import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { getDb } from '../db'
import {
  SYMMETRIC_EDGE_TYPES,
  getClusterMembers,
  getClusterThought,
  getEdgePairBetween,
  isValidEdgeType
} from '../db/edges'
import { getProposal, updateProposalState, type PlacementProposalRow } from '../db/placement-proposals'
import { getThoughtRow } from '../db/thoughts'
import {
  ClusterEdgeValidationError,
  EdgeAlreadyExistsError,
  EdgeConflictError,
  InvalidEdgeTypeError,
  NotFoundError,
  SelfLoopEdgeError,
  ValidationError
} from '../errors'
import { insertLog } from '../logging/log'
import { createEdgeService } from './edges.service'
import type { AcceptedApplyResult, ApplyBatchOutcome, ApplyOptions, ApplyResult, PlannedWriterCall } from './placement-apply.types'
import { isProposalStale } from './placement-proposals.service'
import { archiveThoughtById, mergeThoughtsService } from './thoughts.service'

export type { AcceptedApplyResult, ApplyBatchOutcome, ApplyOptions, ApplyResult, PlannedWriter, PlannedWriterCall } from './placement-apply.types'

/** The (source, target, type) an edge-creating item would write, if any. */
interface PlannedEdge {
  sourceId: string
  targetId: string
  type: string
}

type Gate = { kind: 'ok' } | { kind: 'already_applied' } | { kind: 'stale'; reason: string } | { kind: 'failed'; reason: string }

/** Resolve the edge a proposal would create (ADR §2.5 / §2.6). */
function plannedEdge(row: PlacementProposalRow, options: ApplyOptions): PlannedEdge | undefined {
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

/** The existing-writer call(s) `confirm:true` would execute (never mutates). */
function plannedCalls(row: PlacementProposalRow, options: ApplyOptions): PlannedWriterCall[] {
  const edge = plannedEdge(row, options)
  if (edge) {
    const calls: PlannedWriterCall[] = [
      { writer: 'createEdgeService', args: { sourceId: edge.sourceId, targetId: edge.targetId, type: edge.type } }
    ]
    if (row.item_kind === 'lifecycle') calls.push({ writer: 'archiveThoughtById', args: { id: edge.targetId } })
    return calls
  }
  if (row.item_kind === 'lifecycle' && row.lifecycle_action === 'merge' && row.target_id) {
    const args = {
      sourceId: row.source_thought_id,
      targetId: row.target_id,
      mergedContent: options.mergedContent,
      mergedTags: options.mergedTags
    }
    return [{ writer: 'mergeThoughtsService', args }]
  }
  return []
}

/**
 * Staleness + state-dependent gates (ADR §2.3, §2.6, §2.10.5). Read-only, so it
 * can run for a dry-run too.
 */
function evaluateGates(row: PlacementProposalRow, options: ApplyOptions, d: Database): Gate {
  const source = getThoughtRow(d, row.source_thought_id)
  if (!source) return { kind: 'stale', reason: 'source thought no longer exists' }
  const target = row.target_id ? getThoughtRow(d, row.target_id) : undefined
  if (row.target_id && !target) return { kind: 'stale', reason: 'target thought no longer exists' }

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

interface WriterRun {
  calls: PlannedWriterCall[]
  result: Record<string, unknown>
}

/** Execute one existing writer for a validated `ok` row (ADR §2.5). */
function executeWriter(row: PlacementProposalRow, options: ApplyOptions, d: Database): WriterRun {
  const edge = plannedEdge(row, options)
  if (edge) {
    const created = createEdgeService(edge.sourceId, edge.targetId, edge.type, d)
    if (row.item_kind === 'lifecycle') archiveThoughtById(edge.targetId, d)
    return { calls: plannedCalls(row, options), result: { edge_id: created.id } }
  }
  if (row.item_kind === 'lifecycle' && row.lifecycle_action === 'merge' && row.target_id) {
    const merged = mergeThoughtsService(
      { sourceId: row.source_thought_id, targetId: row.target_id, mergedContent: options.mergedContent, mergedTags: options.mergedTags },
      d
    )
    return { calls: plannedCalls(row, options), result: { transferred_edges: merged.transferredEdges } }
  }
  throw new ValidationError('proposal has no supported apply action')
}

type WriterErrorOutcome = { kind: 'stale' | 'failed' | 'already_applied'; reason: string }

/** Map a writer exception to the conflict matrix (ADR §2.6). */
function mapWriterError(err: unknown): WriterErrorOutcome {
  if (err instanceof EdgeAlreadyExistsError) {
    // Exact directed duplicate: the requested state already holds.
    return { kind: 'already_applied', reason: err.message }
  }
  if (err instanceof EdgeConflictError) return { kind: 'stale', reason: err.message }
  if (err instanceof ValidationError) {
    // `merge.ts` throws "Source thought is already archived" — the graph moved.
    const stale = err.message.toLowerCase().includes('already archived')
    return { kind: stale ? 'stale' : 'failed', reason: err.message }
  }
  if (err instanceof ClusterEdgeValidationError || err instanceof InvalidEdgeTypeError || err instanceof SelfLoopEdgeError) {
    return { kind: 'failed', reason: err.message }
  }
  if (err instanceof NotFoundError) return { kind: 'stale', reason: err.message }
  return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) }
}

/** Mark an already-satisfied item accepted without calling a writer (ADR §2.7). */
function acceptIdempotent(row: PlacementProposalRow, now: string, decidedBy: string | null, options: ApplyOptions, d: Database): AcceptedApplyResult {
  const result = JSON.stringify({ idempotent: true })
  updateProposalState(d, row.id, { state: 'accepted', decided_at: now, decided_by: decidedBy, applied_at: now, result })
  insertLog('info', 'placement', `Applied placement proposal ${row.id} (idempotent)`, {
    proposal_id: row.id,
    item_kind: row.item_kind,
    agent: decidedBy
  })
  return { proposal_id: row.id, item_kind: row.item_kind, status: 'accepted', idempotent: true, calls: plannedCalls(row, options), result }
}

/**
 * Record a terminal `stale` (re-propose required) or a retryable `failed`
 * outcome. A failed row stays `pending` so the caller can fix the precondition
 * and retry (ADR §2.2, §2.6).
 */
function persistOutcome(row: PlacementProposalRow, status: 'stale' | 'failed', reason: string, now: string, decidedBy: string | null, d: Database): void {
  const terminal = status === 'stale'
  const result = JSON.stringify({ status, reason })
  updateProposalState(d, row.id, {
    state: terminal ? 'stale' : 'pending',
    decided_at: terminal ? now : null,
    decided_by: terminal ? decidedBy : null,
    applied_at: null,
    result
  })
  const prefix = terminal ? `Placement proposal ${row.id} is stale` : `Placement proposal ${row.id} failed to apply`
  insertLog('warning', 'placement', `${prefix}: ${reason}`, { proposal_id: row.id, item_kind: row.item_kind, reason })
}

/**
 * Apply exactly one queued proposal (ADR §2.5–2.8).
 *
 * Returns a typed result — a `stale` refusal is a return value, not a throw.
 * Only an unknown proposal id throws `NotFoundError`.
 */
export function applyProposal(proposalId: string, options: ApplyOptions = {}, d: Database = getDb()): ApplyResult {
  const row = getProposal(d, proposalId)
  if (!row) throw new NotFoundError(`placement proposal '${proposalId}' not found`)

  const base = { proposal_id: proposalId, item_kind: row.item_kind }

  // Re-applying an accepted row is idempotent: the queue row is the guard and
  // no writer is called (ADR §2.7).
  if (row.state === 'accepted') {
    return { ...base, status: 'accepted', idempotent: true, calls: [], result: row.result }
  }
  if (row.state === 'stale') return { ...base, status: 'stale', reason: 'proposal is already stale' }
  if (row.state !== 'pending') return { ...base, status: 'failed', reason: `proposal is '${row.state}', not 'pending'` }

  const gate = evaluateGates(row, options, d)

  // Dry-run: validate and report the planned call without touching the graph
  // or the queue (ADR §2.10.3). A refusal is surfaced with the same shape.
  if (options.confirm !== true) {
    if (gate.kind === 'stale') return { ...base, status: 'stale', reason: gate.reason }
    if (gate.kind === 'failed') return { ...base, status: 'failed', reason: gate.reason }
    return { ...base, status: 'dry_run', calls: plannedCalls(row, options) }
  }

  const now = options.now ?? new Date().toISOString()
  const decidedBy = options.decidedBy ?? null

  if (gate.kind === 'stale') {
    persistOutcome(row, 'stale', gate.reason, now, decidedBy, d)
    return { ...base, status: 'stale', reason: gate.reason }
  }
  if (gate.kind === 'failed') {
    persistOutcome(row, 'failed', gate.reason, now, decidedBy, d)
    return { ...base, status: 'failed', reason: gate.reason }
  }
  if (gate.kind === 'already_applied') return acceptIdempotent(row, now, decidedBy, options, d)

  try {
    // One item = one transaction: the existing writer and the queue-state
    // update commit together (ADR §2.7). Nested writer transactions are
    // savepoints, so a writer failure rolls both back.
    const run = d.transaction(() => {
      const executed = executeWriter(row, options, d)
      const result = JSON.stringify(executed.result)
      const updated = updateProposalState(d, proposalId, { state: 'accepted', decided_at: now, decided_by: decidedBy, applied_at: now, result })
      return { executed, updated }
    })
    const outcome = run()
    insertLog('info', 'placement', `Applied placement proposal ${proposalId}`, {
      proposal_id: proposalId,
      item_kind: row.item_kind,
      source_id: row.source_thought_id,
      target_id: row.target_id,
      agent: decidedBy,
      result: outcome.executed.result
    })
    return {
      ...base,
      status: 'accepted',
      idempotent: false,
      calls: outcome.executed.calls,
      result: outcome.updated?.result ?? null
    }
  } catch (err) {
    const mapped = mapWriterError(err)
    if (mapped.kind === 'stale') {
      persistOutcome(row, 'stale', mapped.reason, now, decidedBy, d)
      return { ...base, status: 'stale', reason: mapped.reason }
    }
    if (mapped.kind === 'failed') {
      persistOutcome(row, 'failed', mapped.reason, now, decidedBy, d)
      return { ...base, status: 'failed', reason: mapped.reason }
    }
    // already_applied: the writer signalled the requested state already held.
    return acceptIdempotent(row, now, decidedBy, options, d)
  }
}

/**
 * Apply a list of proposals, each independently (ADR §2.7). Never wraps the
 * items in one cross-item transaction: a partial batch is a valid outcome.
 */
export function applyBatch(
  proposalIds: string[],
  options: ApplyOptions = {},
  d: Database = getDb()
): ApplyBatchOutcome {
  if (!Array.isArray(proposalIds)) throw new ValidationError('proposal_ids must be an array')
  const results: ApplyResult[] = []
  const errors: ApplyBatchOutcome['errors'] = []
  for (const proposalId of proposalIds) {
    try {
      results.push(applyProposal(proposalId, options, d))
    } catch (err) {
      errors.push({ proposal_id: proposalId, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { results, errors }
}
