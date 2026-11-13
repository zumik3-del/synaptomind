import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { getDb } from '../db'
import {
  isLegacyItemKind,
  listAcceptedProposalsByRun,
  updateProposalState,
  type PlacementProposalRow
} from '../db/placement-proposals'
import { ValidationError } from '../errors'
import { insertLog } from '../logging/log'
import { deleteEdgeService } from './edges.service'
import type { RollbackItemReport, RollbackOptions, RollbackReport } from './placement-apply.types'
import { isProposalStale } from './placement-proposals.service'
import { parseResult, planWriterCalls } from './writer-calls.service'
import { MS_PER_DAY } from '../utils'

type Decision = { action: 'revert' } | { action: 'skipped' | 'refused'; reason: string }

// The rollback window is the retention window; a row that cannot be measured is refused, never reverted.
function windowRefusal(row: PlacementProposalRow, now: string): Decision | null {
  const ttlDays = config.placement.proposalTtlDays
  if (ttlDays < 0) return null

  const nowMs = Date.parse(now)
  if (Number.isNaN(nowMs)) {
    return { action: 'refused', reason: 'cannot verify the rollback window: unparseable now' }
  }
  const decidedMs = row.decided_at === null ? Number.NaN : Date.parse(row.decided_at)
  if (Number.isNaN(decidedMs)) {
    return {
      action: 'refused',
      reason: 'accepted row has no decided_at; cannot verify the rollback window'
    }
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

function decideRollback(row: PlacementProposalRow, now: string, d: Database): Decision {
  const outsideWindow = windowRefusal(row, now)
  if (outsideWindow) return outsideWindow
  if (isLegacyItemKind(row.item_kind)) {
    return {
      action: 'refused',
      reason: `item kind '${row.item_kind}' is no longer supported; it cannot be rolled back`
    }
  }
  if (parseResult(row.result).idempotent === true) {
    return { action: 'skipped', reason: 'accepted idempotently; no graph mutation to revert' }
  }
  if (isProposalStale(row, d)) {
    return { action: 'skipped', reason: 'the graph changed since apply (fingerprint mismatch)' }
  }
  return { action: 'revert' }
}

function applyInverse(row: PlacementProposalRow, d: Database): void {
  const calls = planWriterCalls(row, 'rollback')
  if (!calls) throw new ValidationError(`proposal '${row.id}' has no reversible apply action`)

  for (const call of calls) {
    switch (call.writer) {
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

export function rollbackService(
  runId: string,
  options: RollbackOptions = {},
  d: Database = getDb()
): RollbackReport {
  if (!runId) throw new ValidationError('run_id is required')

  const confirm = options.confirm === true
  const now = options.now ?? new Date().toISOString()
  const decidedBy = options.decidedBy ?? null
  const accepted = listAcceptedProposalsByRun(d, runId)

  const items: RollbackItemReport[] = []
  for (const row of accepted) {
    const decision = decideRollback(row, now, d)
    if (decision.action !== 'revert') {
      if (confirm) {
        insertLog(
          'warning',
          'placement',
          `Rollback ${decision.action} proposal ${row.id}: ${decision.reason}`,
          {
            proposal_id: row.id,
            run_id: runId,
            item_kind: row.item_kind
          }
        )
      }
      items.push({
        proposal_id: row.id,
        item_kind: row.item_kind,
        action: decision.action,
        reason: decision.reason
      })
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
