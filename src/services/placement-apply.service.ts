import type { Database } from 'bun:sqlite'
import { getDb } from '../db'
import {
  getProposal,
  isLegacyItemKind,
  updateProposalState,
  type PlacementProposalRow
} from '../db/placement-proposals'
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
import { evaluateGates, plannedEdge } from './apply-gates.service'
import { resolveApplyRunId, resolveBatchRunId } from './apply-run-envelope.service'
import { createEdgeService } from './edges.service'
import type {
  AcceptedApplyResult,
  ApplyBatchOutcome,
  ApplyOptions,
  ApplyResult,
  PlannedWriterCall
} from './placement-apply.types'
import { pairFingerprint } from './placement-proposals.service'
import { type ApplyWriterCall, planWriterCalls, type WriterCall } from './writer-calls.service'

export type {
  AcceptedApplyResult,
  ApplyBatchOutcome,
  ApplyOptions,
  ApplyResult,
  PlannedWriter,
  PlannedWriterCall,
  RefusedApplyResult,
  RunRefusal
} from './placement-apply.types'

export const MAX_EDGE_ITEMS_PER_RUN = 20

function isApplyWriterCall(call: WriterCall): call is ApplyWriterCall {
  return call.writer !== 'deleteEdgeService'
}

function plannedCalls(row: PlacementProposalRow): ApplyWriterCall[] {
  return (planWriterCalls(row, 'apply', plannedEdge(row)) ?? []).filter(isApplyWriterCall)
}

interface WriterRun {
  calls: PlannedWriterCall[]
  result: Record<string, unknown>
}

function executeWriter(row: PlacementProposalRow, d: Database): WriterRun {
  const calls = plannedCalls(row)
  if (calls.length === 0) throw new ValidationError('proposal has no supported apply action')

  const result: Record<string, unknown> = {}
  for (const call of calls) {
    switch (call.writer) {
      case 'createEdgeService': {
        const created = createEdgeService(call.args.sourceId, call.args.targetId, call.args.type, d)
        result.edge_id = created.id
        break
      }
    }
  }
  return { calls, result }
}

type WriterErrorOutcome = { kind: 'stale' | 'failed' | 'already_applied'; reason: string }

function mapWriterError(err: unknown): WriterErrorOutcome {
  if (err instanceof EdgeAlreadyExistsError) {
    return { kind: 'already_applied', reason: err.message }
  }
  if (err instanceof EdgeConflictError) return { kind: 'stale', reason: err.message }
  if (err instanceof ValidationError) {
    // No typed error for this one: the message text is the only signal.
    const stale = err.message.toLowerCase().includes('already archived')
    return { kind: stale ? 'stale' : 'failed', reason: err.message }
  }
  if (
    err instanceof ClusterEdgeValidationError ||
    err instanceof InvalidEdgeTypeError ||
    err instanceof SelfLoopEdgeError
  ) {
    return { kind: 'failed', reason: err.message }
  }
  if (err instanceof NotFoundError) return { kind: 'stale', reason: err.message }
  return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) }
}

function acceptIdempotent(
  row: PlacementProposalRow,
  now: string,
  decidedBy: string | null,
  runId: string,
  d: Database
): AcceptedApplyResult {
  const result = JSON.stringify({ idempotent: true, run_id: runId })
  updateProposalState(d, row.id, {
    state: 'accepted',
    decided_at: now,
    decided_by: decidedBy,
    applied_at: now,
    result,
    run_id: runId
  })
  insertLog('info', 'placement', `Applied placement proposal ${row.id} (idempotent)`, {
    proposal_id: row.id,
    item_kind: row.item_kind,
    agent: decidedBy,
    run_id: runId
  })
  return {
    proposal_id: row.id,
    item_kind: row.item_kind,
    status: 'accepted',
    idempotent: true,
    calls: plannedCalls(row),
    result,
    run_id: runId
  }
}

function persistOutcome(
  row: PlacementProposalRow,
  status: 'stale' | 'failed',
  reason: string,
  now: string,
  decidedBy: string | null,
  d: Database
): void {
  const terminal = status === 'stale'
  const result = JSON.stringify({ status, reason })
  updateProposalState(d, row.id, {
    state: terminal ? 'stale' : 'pending',
    decided_at: terminal ? now : null,
    decided_by: terminal ? decidedBy : null,
    applied_at: null,
    result
  })
  const prefix = terminal
    ? `Placement proposal ${row.id} is stale`
    : `Placement proposal ${row.id} failed to apply`
  insertLog('warning', 'placement', `${prefix}: ${reason}`, {
    proposal_id: row.id,
    item_kind: row.item_kind,
    reason
  })
}

export function applyProposalService(
  proposalId: string,
  options: ApplyOptions = {},
  d: Database = getDb()
): ApplyResult {
  const row = getProposal(d, proposalId)
  if (!row) throw new NotFoundError(`placement proposal '${proposalId}' not found`)

  const base = { proposal_id: proposalId, item_kind: row.item_kind }

  if (isLegacyItemKind(row.item_kind)) {
    return {
      ...base,
      status: 'refused',
      refusal: {
        code: 'unsupported_item_kind',
        reason: `item kind '${row.item_kind}' is no longer supported; it cannot be applied`
      }
    }
  }

  if (row.state === 'accepted') {
    return {
      ...base,
      status: 'accepted',
      idempotent: true,
      calls: [],
      result: row.result,
      run_id: row.run_id
    }
  }
  if (row.state === 'stale')
    return { ...base, status: 'stale', reason: 'proposal is already stale' }
  if (row.state !== 'pending')
    return { ...base, status: 'failed', reason: `proposal is '${row.state}', not 'pending'` }

  const gate = evaluateGates(row, options, d)

  if (options.confirm !== true) {
    if (gate.kind === 'stale') return { ...base, status: 'stale', reason: gate.reason }
    if (gate.kind === 'failed') return { ...base, status: 'failed', reason: gate.reason }
    return { ...base, status: 'dry_run', calls: plannedCalls(row) }
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

  const runId = resolveApplyRunId(options)

  if (gate.kind === 'already_applied') return acceptIdempotent(row, now, decidedBy, runId, d)

  try {
    // Nested writer transactions are savepoints, so a writer failure rolls back both.
    const run = d.transaction(() => {
      const executed = executeWriter(row, d)
      const result = JSON.stringify({ ...executed.result, run_id: runId })
      const updated = updateProposalState(d, proposalId, {
        state: 'accepted',
        decided_at: now,
        decided_by: decidedBy,
        applied_at: now,
        result,
        run_id: runId,
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
    return acceptIdempotent(row, now, decidedBy, runId, d)
  }
}

export function applyBatchService(
  proposalIds: string[],
  options: ApplyOptions = {},
  d: Database = getDb()
): ApplyBatchOutcome {
  if (!Array.isArray(proposalIds)) throw new ValidationError('proposal_ids must be an array')

  if (options.limit !== undefined && proposalIds.length > options.limit) {
    return {
      results: [],
      errors: [],
      refused: {
        code: 'limit_exceeded',
        reason: `batch has ${proposalIds.length} items but limit is ${options.limit}`
      }
    }
  }

  const rows = proposalIds.map(id => getProposal(d, id))

  const pendingEdges = rows.filter(
    row => row !== undefined && row.item_kind === 'edge' && row.state === 'pending'
  ).length
  if (pendingEdges > MAX_EDGE_ITEMS_PER_RUN) {
    return {
      results: [],
      errors: [],
      refused: {
        code: 'limit_exceeded',
        reason: `run has ${pendingEdges} edge items but the per-run cap is ${MAX_EDGE_ITEMS_PER_RUN}; split the run`
      }
    }
  }

  const batchRunId = resolveBatchRunId(rows, options)

  const results: ApplyResult[] = []
  const errors: ApplyBatchOutcome['errors'] = []
  for (const proposalId of proposalIds) {
    try {
      results.push(applyProposalService(proposalId, { ...options, runId: batchRunId }, d))
    } catch (err) {
      errors.push({
        proposal_id: proposalId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
  const joinedRun =
    batchRunId !== undefined &&
    results.some(r => r.status === 'accepted' && r.run_id === batchRunId)
  return joinedRun ? { results, errors, run_id: batchRunId } : { results, errors }
}
