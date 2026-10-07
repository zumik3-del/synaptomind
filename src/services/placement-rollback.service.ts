/**
 * Run-scoped rollback for the explicit placement/triage apply orchestrator
 * (ADR 2026-09-29 §2.8).
 *
 * The accepted rows of one `run_id` are the rollback manifest: `rollback`
 * iterates them in reverse application order and inverts each reversible
 * mutation through **existing** writers only (`updateThoughtById`,
 * `deleteEdgeService`). Nothing is hard-deleted: a row decided outside the
 * rollback window is refused, a `merge` row is refused as not
 * auto-rollbackable, and a row whose stored fingerprint no longer matches
 * the graph is skipped with a warning. `confirm: false` (default) is a
 * non-mutating dry-run report. No ambient/scheduled caller invokes this.
 */

import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { getDb } from '../db'
import { listAcceptedProposalsByRun, updateProposalState, type PlacementProposalRow } from '../db/placement-proposals'
import { ValidationError } from '../errors'
import { insertLog } from '../logging/log'
import { deleteEdgeService } from './edges.service'
import type { RollbackItemReport, RollbackOptions, RollbackReport } from './placement-apply.types'
import { isProposalStale } from './placement-proposals.service'
import { updateThoughtById } from './thoughts.service'
import { parseResult, planWriterCalls } from './writer-calls'

type Decision = { action: 'revert' } | { action: 'skipped' | 'refused'; reason: string }

const MS_PER_DAY = 86400000

/**
 * Refuse a row decided outside the rollback window (ADR 2026-09-29 §2.8, OQ-3:
 * "While the run's rows are retained (proposal TTL) …; older → refuse + warn").
 * The window IS the retention window — `placement.proposalTtlDays` — so this is
 * the read-time backstop for a not-yet-run/slow retention job. A negative TTL
 * disables retention and therefore the guard. Fails closed: a row that cannot
 * be measured (missing/unparseable `decided_at` or clock) is refused, never
 * reverted. Returns `null` when the row is in-window.
 */
function windowRefusal(row: PlacementProposalRow, now: string): Decision | null {
  const ttlDays = config.placement.proposalTtlDays
  if (ttlDays < 0) return null

  const nowMs = Date.parse(now)
  if (Number.isNaN(nowMs)) {
    return { action: 'refused', reason: 'cannot verify the rollback window: unparseable now' }
  }
  const decidedMs = row.decided_at === null ? Number.NaN : Date.parse(row.decided_at)
  if (Number.isNaN(decidedMs)) {
    return { action: 'refused', reason: 'accepted row has no decided_at; cannot verify the rollback window' }
  }

  const cutoff = new Date(nowMs - ttlDays * MS_PER_DAY).toISOString()
  if (decidedMs < Date.parse(cutoff)) {
    return {
      action: 'refused',
      reason: `decided_at ${row.decided_at} is older than the ${ttlDays}d rollback window (cutoff ${cutoff})`
    }
  }
  return null
}

/**
 * Read-only verdict for one accepted row (ADR §2.8): the rollback window is
 * checked first (a refusal is terminal and outranks the rest), `merge` is
 * refused, an idempotent accept mutated nothing, and a fingerprint drift means
 * the graph moved since apply — all non-revertible; everything else is
 * revertible.
 */
function decideRollback(row: PlacementProposalRow, now: string, d: Database): Decision {
  const outsideWindow = windowRefusal(row, now)
  if (outsideWindow) return outsideWindow
  if (row.item_kind === 'lifecycle' && row.lifecycle_action === 'merge') {
    return { action: 'refused', reason: 'merge is not auto-rollbackable' }
  }
  if (parseResult(row.result).idempotent === true) {
    return { action: 'skipped', reason: 'accepted idempotently; no graph mutation to revert' }
  }
  if (isProposalStale(row, d)) {
    return { action: 'skipped', reason: 'the graph changed since apply (fingerprint mismatch)' }
  }
  return { action: 'revert' }
}

/** Apply the inverse of one accepted row through existing writers only. */
function applyInverse(row: PlacementProposalRow, d: Database): void {
  const calls = planWriterCalls(row, 'rollback')
  if (!calls) throw new ValidationError(`proposal '${row.id}' has no reversible apply action`)

  for (const call of calls) {
    switch (call.writer) {
      case 'updateThoughtById':
        // A triage source returns to `draft`; a `replaces+archive` target returns
        // to `active` — the apply-time gate only admits an `active` target
        // (`apply-gates.ts`), so restoring `draft` would silently drop it out of
        // active recall.
        updateThoughtById(call.args.id, { status: call.args.status }, d)
        break
      case 'deleteEdgeService':
        deleteEdgeService(call.args.id, d)
        break
    }
  }
}

function summarize(items: RollbackItemReport[]): RollbackReport['summary'] {
  return {
    reverted: items.filter(i => i.action === 'reverted').length,
    skipped: items.filter(i => i.action === 'skipped').length,
    refused: items.filter(i => i.action === 'refused').length
  }
}

/**
 * Roll back every accepted row of `runId` in reverse application order
 * (ADR §2.8). Default `confirm:false` is a read-only preview; `confirm:true`
 * performs each inverse in its own transaction and marks the row `rolled_back`
 * with `decided_at` (so retention can prune it). Returns the per-row report.
 */
export function rollback(runId: string, options: RollbackOptions = {}, d: Database = getDb()): RollbackReport {
  if (!runId) throw new ValidationError('run_id is required')

  const confirm = options.confirm === true
  const now = options.now ?? new Date().toISOString()
  const decidedBy = options.decidedBy ?? null
  // Reverse application order is `applied_at` descending — the order the run
  // confirmed its items in, not the order they were enqueued (ADR 2026-09-29 §2.8).
  const accepted = listAcceptedProposalsByRun(d, runId)

  const items: RollbackItemReport[] = []
  for (const row of accepted) {
    const decision = decideRollback(row, now, d)
    if (decision.action !== 'revert') {
      if (confirm) {
        insertLog('warning', 'placement', `Rollback ${decision.action} proposal ${row.id}: ${decision.reason}`, {
          proposal_id: row.id,
          run_id: runId,
          item_kind: row.item_kind
        })
      }
      items.push({ proposal_id: row.id, item_kind: row.item_kind, action: decision.action, reason: decision.reason })
      continue
    }

    if (!confirm) {
      items.push({ proposal_id: row.id, item_kind: row.item_kind, action: 'reverted' })
      continue
    }

    try {
      d.transaction(() => {
        applyInverse(row, d)
        updateProposalState(d, row.id, {
          state: 'rolled_back',
          decided_at: now,
          decided_by: decidedBy,
          applied_at: null,
          result: JSON.stringify({ run_id: runId, rolled_back: true })
        })
      })()
      insertLog('info', 'placement', `Rolled back proposal ${row.id} (run ${runId})`, {
        proposal_id: row.id,
        run_id: runId,
        item_kind: row.item_kind,
        agent: decidedBy
      })
      items.push({ proposal_id: row.id, item_kind: row.item_kind, action: 'reverted' })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      insertLog('warning', 'placement', `Rollback of proposal ${row.id} failed: ${reason}`, {
        proposal_id: row.id,
        run_id: runId,
        item_kind: row.item_kind
      })
      items.push({ proposal_id: row.id, item_kind: row.item_kind, action: 'skipped', reason })
    }
  }

  return { run_id: runId, confirm, items, summary: summarize(items) }
}
