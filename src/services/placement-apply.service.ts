/**
 * Explicit per-item `apply` for queued placement proposals (ADR 2026-09-28 P8,
 * §2.5–2.8 / R4).
 *
 * Thin orchestrator: it never writes the graph itself — every mutation
 * delegates to an existing writer (`createEdgeService`, `mergeThoughtsService`,
 * `archiveThoughtById`, `updateThoughtById`) inside the same transaction as the
 * queue-state update, so the graph and the queue cannot diverge (ADR §2.7).
 * `confirm: false` (the default) is a non-mutating dry-run; nothing
 * ambient/scheduled calls `apply`.
 *
 * Conflict matrix (ADR §2.6): exact/symmetric duplicate → idempotent success;
 * reverse/different-type conflict, archived target, stale fingerprint, cluster
 * over `maxClusterSize` → `stale`; profile, invalid type, cluster constraint
 * violation → typed `failed`.
 *
 * Triage kinds (`triage_activate`/`triage_archive`, ADR 2026-09-29 §2.3.4) are
 * gated in `apply-gates.ts` and applied on the *draft* source through
 * `updateThoughtById`/`archiveThoughtById`; the accepted row records the
 * `run_id` envelope that `rollback` (in `placement-rollback.service.ts`)
 * inverts later.
 *
 * Every row this service accepts carries such an envelope (ADR 2026-09-29
 * §2.7, §2.8): the caller's `run_id` verbatim, or — for a non-triage item the
 * caller left un-enveloped — one synthesized by `apply-run-envelope.ts` and
 * handed back, so no committed mutation is unreachable by `rollback(run_id)`.
 * Triage kinds keep requiring a caller-supplied `run_id`; `applyBatch` shares
 * one envelope across the whole batch.
 */

import type { Database } from 'bun:sqlite'
import { getDb } from '../db'
import { getProposal, updateProposalState, type PlacementProposalRow } from '../db/placement-proposals'
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
import { evaluateGates, plannedEdge } from './apply-gates'
import { resolveApplyRunId, resolveBatchRunId, triageEnvelope } from './apply-run-envelope'
import { checkBatchGuards, isTriageKind } from './apply-run-guards'
import { createEdgeService } from './edges.service'
import type { AcceptedApplyResult, ApplyBatchOutcome, ApplyOptions, ApplyResult, PlannedWriterCall } from './placement-apply.types'
import { pairFingerprint } from './placement-proposals.service'
import { archiveThoughtById, mergeThoughtsService, updateThoughtById } from './thoughts.service'
import { type ApplyWriterCall, planWriterCalls, type WriterCall } from './writer-calls'

export type { AcceptedApplyResult, ApplyBatchOutcome, ApplyOptions, ApplyResult, PlannedWriter, PlannedWriterCall, RefusedApplyResult, RunRefusal } from './placement-apply.types'

/** The apply direction never plans the rollback-only `deleteEdgeService`. */
function isApplyWriterCall(call: WriterCall): call is ApplyWriterCall {
  return call.writer !== 'deleteEdgeService'
}

/** The existing-writer call(s) `confirm:true` would execute (never mutates). */
function plannedCalls(row: PlacementProposalRow, options: ApplyOptions): ApplyWriterCall[] {
  return (planWriterCalls(row, 'apply', options, plannedEdge(row, options)) ?? []).filter(isApplyWriterCall)
}

interface WriterRun {
  calls: PlannedWriterCall[]
  result: Record<string, unknown>
}

/**
 * Plan and execute the existing-writer call(s) for a validated `ok` row
 * (ADR §2.5): one dispatch produces both the plan reported back to the caller
 * and the execution result stored on the row.
 */
function executeWriter(row: PlacementProposalRow, options: ApplyOptions, d: Database): WriterRun {
  const calls = plannedCalls(row, options)
  if (calls.length === 0) throw new ValidationError('proposal has no supported apply action')

  const result: Record<string, unknown> = {}
  for (const call of calls) {
    switch (call.writer) {
      case 'updateThoughtById':
        updateThoughtById(call.args.id, { status: call.args.status }, d)
        break
      case 'archiveThoughtById':
        archiveThoughtById(call.args.id, d)
        break
      case 'createEdgeService': {
        const created = createEdgeService(call.args.sourceId, call.args.targetId, call.args.type, d)
        result.edge_id = created.id
        break
      }
      case 'mergeThoughtsService':
        result.transferred_edges = mergeThoughtsService(call.args, d).transferredEdges
        break
    }
  }
  // A triage accept records its before/after provenance envelope (ADR §2.3.4).
  if (row.item_kind === 'triage_activate' || row.item_kind === 'triage_archive') {
    Object.assign(result, triageEnvelope(row, row.item_kind === 'triage_archive' ? 'archived' : 'active'))
  }
  return { calls, result }
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

/**
 * Mark an already-satisfied item accepted without calling a writer (ADR §2.7).
 * It mutates nothing, but it is still an accepted row and still joins a run —
 * `rollback` reads `result.idempotent` to report it as `skipped`, not reverted.
 */
function acceptIdempotent(
  row: PlacementProposalRow,
  now: string,
  decidedBy: string | null,
  options: ApplyOptions,
  runId: string,
  d: Database
): AcceptedApplyResult {
  const result = JSON.stringify({ idempotent: true, run_id: runId })
  updateProposalState(d, row.id, { state: 'accepted', decided_at: now, decided_by: decidedBy, applied_at: now, result, run_id: runId })
  insertLog('info', 'placement', `Applied placement proposal ${row.id} (idempotent)`, {
    proposal_id: row.id,
    item_kind: row.item_kind,
    agent: decidedBy,
    run_id: runId
  })
  return { proposal_id: row.id, item_kind: row.item_kind, status: 'accepted', idempotent: true, calls: plannedCalls(row, options), result, run_id: runId }
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
  // no writer is called (ADR §2.7). The run it was accepted under is echoed
  // back, so this stays a faithful report of the row.
  if (row.state === 'accepted') {
    return { ...base, status: 'accepted', idempotent: true, calls: [], result: row.result, run_id: row.run_id }
  }
  if (row.state === 'stale') return { ...base, status: 'stale', reason: 'proposal is already stale' }
  if (row.state !== 'pending') return { ...base, status: 'failed', reason: `proposal is '${row.state}', not 'pending'` }

  // A triage item is applied as part of an explicit run; without a run envelope
  // it could never be rolled back (ADR 2026-09-29 §2.7).
  if (options.confirm === true && isTriageKind(row.item_kind) && !options.runId) {
    return {
      ...base,
      status: 'refused',
      refusal: { code: 'run_id_required', reason: `run_id is required to apply ${row.item_kind} item '${proposalId}'` }
    }
  }

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

  // The envelope every accepted row carries (ADR 2026-09-29 §2.7, §2.8), and
  // it MUST be resolved here — past the dry-run branch and the triage refusal
  // above — so nothing is synthesized for a preview and a synthesized id can
  // never satisfy `run_id_required` (triage kinds keep requiring the caller's).
  const runId = resolveApplyRunId(options)

  if (gate.kind === 'already_applied') return acceptIdempotent(row, now, decidedBy, options, runId, d)

  try {
    // One item = one transaction: the existing writer and the queue-state
    // update commit together (ADR §2.7). Nested writer transactions are
    // savepoints, so a writer failure rolls both back.
    const run = d.transaction(() => {
      const executed = executeWriter(row, options, d)
      // The column is the rollback key; the id is echoed into the stored JSON
      // and the log purely for audit (`result` stays opaque JSON elsewhere).
      const result = JSON.stringify({ ...executed.result, run_id: runId })
      const updated = updateProposalState(d, proposalId, {
        state: 'accepted',
        decided_at: now,
        decided_by: decidedBy,
        applied_at: now,
        result,
        run_id: runId,
        // Post-writer snapshot, stored so `rollback` can distinguish
        // "unchanged since apply" from "drifted" (ADR 2026-09-29 §2.8).
        fingerprint: pairFingerprint(d, row.source_thought_id, row.target_id)
      })
      return { executed, updated }
    })
    const outcome = run()
    insertLog('info', 'placement', `Applied placement proposal ${proposalId}`, {
      proposal_id: proposalId,
      item_kind: row.item_kind,
      source_id: row.source_thought_id,
      target_id: row.target_id,
      agent: decidedBy,
      run_id: runId,
      result: outcome.executed.result
    })
    return {
      ...base,
      status: 'accepted',
      idempotent: false,
      calls: outcome.executed.calls,
      result: outcome.updated?.result ?? null,
      run_id: runId
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
    return acceptIdempotent(row, now, decidedBy, options, runId, d)
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

  // Run-scoped guardrails are evaluated once, before any item runs: exceeding
  // a cap, the batch limit, or confirming a triage run without a `run_id`
  // refuses the whole batch instead of applying a prefix (ADR 2026-09-29 §2.7).
  const rows = proposalIds.map(id => getProposal(d, id))
  const refusal = checkBatchGuards(rows, proposalIds.length, options, d)
  if (refusal) return { results: [], errors: [], refused: refusal }

  // One envelope for the whole batch, not one per item: the batch *is* the run
  // (ADR 2026-09-29 §2.7, §2.8). Resolved only after the guards above, which
  // already refused any batch holding a pending triage row without a `run_id`.
  const batchRunId = resolveBatchRunId(rows, options)

  const results: ApplyResult[] = []
  const errors: ApplyBatchOutcome['errors'] = []
  for (const proposalId of proposalIds) {
    try {
      results.push(applyProposal(proposalId, { ...options, runId: batchRunId }, d))
    } catch (err) {
      errors.push({ proposal_id: proposalId, error: err instanceof Error ? err.message : String(err) })
    }
  }
  // Hand the envelope back only when a row actually joined it: a batch that
  // accepted nothing (e.g. every item went `stale`) has no manifest to roll
  // back, so reporting an id there would send the caller after an empty run.
  const joinedRun = batchRunId !== undefined && results.some(r => r.status === 'accepted' && r.run_id === batchRunId)
  return joinedRun ? { results, errors, run_id: batchRunId } : { results, errors }
}
