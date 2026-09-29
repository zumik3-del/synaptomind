/**
 * Run-scoped rollback for the explicit placement/triage apply orchestrator
 * (ADR 2026-09-29 §2.8).
 *
 * The accepted rows of one `run_id` are the rollback manifest: `rollback`
 * iterates them in reverse application order and inverts each reversible
 * mutation through **existing** writers only (`updateThoughtById`,
 * `deleteEdgeService`). Nothing is hard-deleted: a `merge` row is refused as
 * not auto-rollbackable, and a row whose stored fingerprint no longer matches
 * the graph is skipped with a warning. `confirm: false` (default) is a
 * non-mutating dry-run report. No ambient/scheduled caller invokes this.
 */

import type { Database } from 'bun:sqlite'
import { getDb } from '../db'
import { listAcceptedProposalsByRun, updateProposalState, type PlacementProposalRow } from '../db/placement-proposals'
import { ValidationError } from '../errors'
import { insertLog } from '../logging/log'
import { deleteEdgeService } from './edges.service'
import type { RollbackItemReport, RollbackOptions, RollbackReport } from './placement-apply.types'
import { isProposalStale } from './placement-proposals.service'
import { updateThoughtById } from './thoughts.service'

type Decision = { action: 'revert' } | { action: 'skipped' | 'refused'; reason: string }

/** Parse a stored JSON `result` without throwing on legacy/null values. */
function parseResult(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The id of an edge this row created, when its `result` recorded one. */
function createdEdgeId(row: PlacementProposalRow): string | undefined {
  const value = parseResult(row.result).edge_id
  return typeof value === 'string' ? value : undefined
}

/**
 * Read-only verdict for one accepted row (ADR §2.8): `merge` is refused, an
 * idempotent accept mutated nothing, and a fingerprint drift means the graph
 * moved since apply — all non-revertible; everything else is revertible.
 */
function decideRollback(row: PlacementProposalRow, d: Database): Decision {
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
  if (row.item_kind === 'triage_activate' || row.item_kind === 'triage_archive') {
    updateThoughtById(row.source_thought_id, { status: 'draft' }, d)
    return
  }
  const edgeId = createdEdgeId(row)
  if (row.item_kind === 'edge' || row.item_kind === 'placement') {
    if (edgeId) deleteEdgeService(edgeId, d)
    return
  }
  if (row.item_kind === 'lifecycle' && row.lifecycle_action === 'replaces+archive') {
    if (edgeId) deleteEdgeService(edgeId, d)
    // The apply-time gate only admits this item when the target is `active`
    // (`apply-gates.ts`), and the writer archived it — so the inverse restores
    // `active`. Restoring `draft` here would silently drop the thought out of
    // active recall.
    if (row.target_id) updateThoughtById(row.target_id, { status: 'active' }, d)
    return
  }
  throw new ValidationError(`proposal '${row.id}' has no reversible apply action`)
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
    const decision = decideRollback(row, d)
    if (decision.action !== 'revert') {
      if (confirm && decision.action === 'skipped') {
        insertLog('warning', 'placement', `Rollback skipped proposal ${row.id}: ${decision.reason}`, {
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
