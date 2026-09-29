/**
 * Explicit-run guardrails for the triage/placement apply surfaces
 * (ADR 2026-09-29 §2.7): the mandatory dry-run-first preview and the per-run
 * caps (`triage.maxItemsPerRun`, `triage.maxArchivesPerRun`,
 * `triage.maxLinksPerRun`).
 *
 * These guards live at the explicit-run boundary (MCP `memory_review`, HTTP
 * `/api/proposals`) rather than inside the item orchestrator: existing callers
 * of `applyProposal`/`applyBatch` are explicit tests of the writer path and
 * must keep working without a preview. A refusal is always returned — the
 * caller gets a typed `RunRefusal` and **no item runs** (no partial surprise).
 *
 * The dry-run ledger is intentionally process-local: the task forbids new
 * migrations, and a preview is a property of one explicit run in one process,
 * not durable knowledge. It is keyed by DB instance so a fresh test DB starts
 * with an empty ledger.
 */

import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { getDb } from '../db'
import { getProposal, listProposalsByRun, type PlacementProposalRow } from '../db/placement-proposals'
import type { RunRefusal } from './placement-apply.types'

export type TriageItemKind = 'triage_activate' | 'triage_archive'

/** Is `kind` one of the deterministic draft-triage verdicts (ADR §2.2)? */
export function isTriageKind(kind: string): kind is TriageItemKind {
  return kind === 'triage_activate' || kind === 'triage_archive'
}

/** Link/edge-producing item kinds that count toward `triage.maxLinksPerRun` (ADR §2.7). */
export type LinkItemKind = 'edge' | 'placement' | 'lifecycle'

/** Does `kind` produce a graph link/edge rather than a triage verdict? */
export function isLinkKind(kind: string): kind is LinkItemKind {
  return kind === 'edge' || kind === 'placement' || kind === 'lifecycle'
}

const previewedRuns = new WeakMap<Database, Set<string>>()

function ledger(d: Database): Set<string> {
  let seen = previewedRuns.get(d)
  if (!seen) {
    seen = new Set()
    previewedRuns.set(d, seen)
  }
  return seen
}

function triageRows(proposalIds: string[], d: Database): PlacementProposalRow[] {
  return proposalIds
    .map(id => getProposal(d, id))
    .filter((row): row is PlacementProposalRow => row !== undefined && isTriageKind(row.item_kind))
}

/**
 * Config-gated dry-run-first check. Returns a refusal when a confirm targets
 * triage items of a run that was never previewed; `undefined` means allowed.
 */
export function checkDryRunFirst(
  proposalIds: string[],
  runId: string | undefined,
  d: Database = getDb()
): RunRefusal | undefined {
  if (!config.triage.requireDryRunFirst) return undefined
  if (triageRows(proposalIds, d).length === 0) return undefined
  if (!runId) return { code: 'run_id_required', reason: 'run_id is required for triage items' }
  if (!ledger(d).has(runId)) {
    return {
      code: 'dry_run_required',
      reason: `run '${runId}' has no prior dry-run; preview it with confirm=false first (triage.requireDryRunFirst)`
    }
  }
  return undefined
}

/** Record a dry-run preview so a later confirm of the same run is allowed. */
export function noteDryRun(proposalIds: string[], runId: string | undefined, d: Database = getDb()): void {
  if (!runId) return
  if (triageRows(proposalIds, d).length === 0) return
  ledger(d).add(runId)
}

/**
 * The same caps for the single-item `apply` path. Without this the per-run
 * budgets were only reachable through `apply_batch`, so a caller could confirm
 * one item at a time and exceed `maxItemsPerRun`/`maxArchivesPerRun`/
 * `maxLinksPerRun` by an unbounded margin (ADR 2026-09-29 §2.7).
 */
export function checkItemGuards(
  proposalId: string,
  options: { confirm?: boolean; runId?: string },
  d: Database = getDb()
): RunRefusal | undefined {
  if (options.confirm !== true) return undefined
  return checkBatchGuards([getProposal(d, proposalId)], 1, options, d)
}

/**
 * Per-run caps + batch limit, evaluated before any item runs
 * (ADR 2026-09-29 §2.7). Counts are cumulative over the run's already-accepted
 * rows, so several small batches cannot together exceed a cap.
 */
export function checkBatchGuards(
  rows: Array<PlacementProposalRow | undefined>,
  requestedCount: number,
  options: { confirm?: boolean; runId?: string; limit?: number },
  d: Database = getDb()
): RunRefusal | undefined {
  if (options.confirm !== true) return undefined
  const pendingTriage = rows.filter(
    (row): row is PlacementProposalRow => row !== undefined && isTriageKind(row.item_kind) && row.state === 'pending'
  )
  if (pendingTriage.length > 0 && !options.runId) {
    return { code: 'run_id_required', reason: 'run_id is required for triage items' }
  }
  if (options.limit !== undefined && requestedCount > options.limit) {
    return {
      code: 'limit_exceeded',
      reason: `batch has ${requestedCount} items but limit is ${options.limit}`
    }
  }
  if (!options.runId) return undefined

  const accepted = listProposalsByRun(d, options.runId).filter(row => row.state === 'accepted')
  // Triage verdicts and link/edge items have disjoint per-run budgets: each kind
  // is counted only toward its own cap, never both (no double counting).
  const acceptedTriage = accepted.filter(row => isTriageKind(row.item_kind))
  const projectedItems = acceptedTriage.length + pendingTriage.length
  if (projectedItems > config.triage.maxItemsPerRun) {
    return {
      code: 'max_items_exceeded',
      reason: `run '${options.runId}' would hold ${projectedItems} items > triage.maxItemsPerRun ${config.triage.maxItemsPerRun}`
    }
  }
  const acceptedArchives = acceptedTriage.filter(row => row.item_kind === 'triage_archive').length
  const projectedArchives = acceptedArchives + pendingTriage.filter(row => row.item_kind === 'triage_archive').length
  if (projectedArchives > config.triage.maxArchivesPerRun) {
    return {
      code: 'max_archives_exceeded',
      reason: `run '${options.runId}' would hold ${projectedArchives} archives > triage.maxArchivesPerRun ${config.triage.maxArchivesPerRun}`
    }
  }
  const pendingLinks = rows.filter(
    (row): row is PlacementProposalRow => row !== undefined && isLinkKind(row.item_kind) && row.state === 'pending'
  )
  // Only a batch that itself carries link items is capped; the count is
  // cumulative over the run's already-accepted links so several small batches
  // cannot together exceed the cap.
  if (pendingLinks.length > 0) {
    const acceptedLinks = accepted.filter(row => isLinkKind(row.item_kind)).length
    const projectedLinks = acceptedLinks + pendingLinks.length
    if (projectedLinks > config.triage.maxLinksPerRun) {
      return {
        code: 'max_links_exceeded',
        reason: `run '${options.runId}' would hold ${projectedLinks} links > triage.maxLinksPerRun ${config.triage.maxLinksPerRun}`
      }
    }
  }
  return undefined
}
