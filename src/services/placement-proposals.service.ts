/**
 * Persisted placement-proposal queue (ADR 2026-09-28 P8, §2.2–2.4 / R3).
 *
 * Read-only with respect to the graph: this module maps a `PlacementPlan`
 * (produced by the propose-only engine) to rows in `placement_proposals` and
 * manages the review worklist (`list`/`reject`). It never calls a graph writer;
 * applying a queued item is R4 (`placement-apply.service.ts`).
 *
 * Mapping (ADR §2.2, §2.5) — since task #1942 the queue creates `edge` items
 * only: every emitted `EdgeProposal` becomes one `edge` item. A plan's
 * `placement` proposal and its queueable `lifecycle` action are *skipped* and
 * reported in the enqueue outcome, so a caller learns what was dropped instead
 * of losing it silently.
 *
 * Staleness (ADR §2.3): every row stores a `fingerprint` of the exact graph
 * snapshot an apply would touch. Re-enqueue refreshes the live row (dedup is
 * enforced by the partial unique index, `db/placement-proposals.ts`); `list`
 * hides terminal/expired rows by default.
 */

import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { getDb } from '../db'
import {
  getProposal,
  insertProposal,
  isLegacyItemKind,
  listAcceptedProposalsByRun,
  listProposals,
  updateProposalState,
  type InsertProposalInput,
  type PlacementProposalRow,
} from '../db/placement-proposals'
import { getThoughtRow } from '../db/thoughts'
import { NotFoundError, ValidationError } from '../errors'
import { isoDateTimeSchema } from '../validation'
import { DRAFT_THOUGHT_ID, proposePlacementPlan } from './placement/engine'
import type { PlacementPlan } from './placement/types'
import {
  countSkippedKinds,
  itemKey,
  mapPlan,
  pairFingerprint,
  proposalExpiry,
  toItemKey
} from './placement-proposals.mapping'
import type {
  EnqueueOutcome,
  EnqueuePlanOptions,
  EnqueueThoughtOptions,
  ListOptions,
  RejectOptions
} from './placement-proposals.types'
import { clampListLimit, resolveMaxProposalsPerEnqueue } from './placement-proposals.helpers'

export { computeFingerprint, pairFingerprint } from './placement-proposals.mapping'
export type { FingerprintInput } from './placement-proposals.mapping'
export { isLegacyItemKind } from '../db/placement-proposals'

export type {
  EnqueueOutcome,
  EnqueuePlanOptions,
  EnqueueThoughtOptions,
  ListOptions,
  RejectOptions
} from './placement-proposals.types'

export function getProposalService(id: string, d: Database = getDb()): PlacementProposalRow | undefined {
  return getProposal(d, id)
}

export function listAcceptedProposalsByRunService(runId: string, d: Database = getDb()): PlacementProposalRow[] {
  return listAcceptedProposalsByRun(d, runId)
}

export function enqueuePlanService(
  plan: PlacementPlan,
  options: EnqueuePlanOptions = {},
  d: Database = getDb()
): EnqueueOutcome {
  const source = getThoughtRow(d, plan.thought_id)
  if (plan.thought_id === DRAFT_THOUGHT_ID || !source) {
    throw new ValidationError(
      'cannot enqueue proposals for a draft or unknown thought; persist the thought first'
    )
  }
  if (source.status !== 'active') {
    throw new ValidationError(
      `cannot enqueue placement proposals for '${source.status}' thought '${source.id}'; ` +
        'only a thought with status active participates in placement'
    )
  }

  const now = options.now ?? new Date().toISOString()
  const mapped = mapPlan(d, source, plan)
  const skipped = mapped.skipped.length
  const skippedKinds = countSkippedKinds(mapped.skipped)
  const items = mapped.items
  if (items.length === 0) return { proposals: [], skipped, skipped_kinds: skippedKinds }

  // Reduce enqueue noise: cap the number of auto-generated proposals per enqueue.
  const maxPerEnqueue = resolveMaxProposalsPerEnqueue(options)
  const cappedItems = items.slice(0, maxPerEnqueue)
  if (cappedItems.length === 0) return { proposals: [], skipped, skipped_kinds: skippedKinds }

  const maxPending = config.placement.maxPendingProposals
  const expiresAt = proposalExpiry(now)
  const projectId = source.project_id ?? null

  const run = d.transaction(() => {
    // Count only live (non-expired) pending rows so overdue rows do not
    // consume the cap; the retention job marks them expired (ADR §2.4).
    const pending = listProposals(d, { state: 'pending', limit: maxPending + cappedItems.length + 1 })
      .filter(row => row.expires_at === null || row.expires_at > now)
    const keys = new Set(pending.map(toItemKey))
    let pendingCount = pending.length

    const rows: PlacementProposalRow[] = []
    for (const item of cappedItems) {
      const key = itemKey({
        sourceId: source.id,
        itemKind: item.itemKind,
        targetId: item.targetId,
        edgeType: item.edgeType,
        lifecycleAction: item.lifecycleAction
      })
      const isNew = !keys.has(key)
      if (isNew && pendingCount >= maxPending) {
        throw new ValidationError(
          `maximum ${maxPending} pending placement proposals reached; apply or reject existing items first`
        )
      }
      const input: InsertProposalInput = {
        project_id: projectId,
        source_thought_id: source.id,
        item_kind: item.itemKind,
        target_id: item.targetId,
        edge_type: item.edgeType,
        lifecycle_action: item.lifecycleAction,
        direction: item.direction,
        confidence: item.confidence,
        rationale: item.rationale,
        rule_id: item.ruleId,
        payload: item.payload,
        fingerprint: item.fingerprint,
        expires_at: expiresAt
      }
      rows.push(insertProposal(d, input))
      keys.add(key)
      if (isNew) pendingCount++
    }
    return rows
  })

  const rows = run()
  // Clearer output grouping by target/type for review readability.
  rows.sort((a, b) =>
    String(a.item_kind).localeCompare(String(b.item_kind)) ||
    String(a.target_id ?? '').localeCompare(String(b.target_id ?? ''))
  )
  return { proposals: rows, skipped, skipped_kinds: skippedKinds }
}

/**
 * Propose a read-only placement plan for a persisted thought and enqueue its
 * confirmable items (ADR §2.9 / R5). The surface stays thin behind this
 * service call; drafts are rejected (OQ-2) because both the engine's draft
 * sentinel and `enqueuePlanService` refuse a non-persisted source.
 *
 * The outcome reports the queued rows *and* the plan items that were skipped
 * because their kind is no longer supported (task #1942).
 */
export async function enqueueThoughtProposals(
  thoughtId: string,
  options: EnqueueThoughtOptions = {},
  d: Database = getDb()
): Promise<EnqueueOutcome> {
  const maxPerEnqueue = resolveMaxProposalsPerEnqueue(options)
  const plan = await proposePlacementPlan(
    { thoughtId, projectId: options.projectId },
    { projectId: options.projectId, now: options.now, maxProposals: maxPerEnqueue },
    {},
    d
  )
  return enqueuePlanService(plan, { now: options.now, maxProposals: maxPerEnqueue }, d)
}

export function listPlacementProposalsService(options: ListOptions = {}, d: Database = getDb()): PlacementProposalRow[] {
  const state = options.state ?? 'pending'
  const now = options.now ?? new Date().toISOString()
  const sourceThoughtId = options.sourceThoughtId ?? options.source_thought_id
  const createdAfter = options.createdAfter ?? options.created_after
  const projectId = options.projectId ?? options.project_id
  const itemKind = options.itemKind ?? options.item_kind
  const includeRetired = options.includeRetired ?? options.include_retired ?? false
  if (createdAfter !== undefined && !isoDateTimeSchema.safeParse(createdAfter).success) {
    throw new ValidationError(`Invalid created_after: ${String(createdAfter)}. Must be a valid ISO timestamp.`)
  }
  const rows = listProposals(d, {
    state,
    project_id: projectId,
    item_kind: itemKind,
    source_thought_id: sourceThoughtId,
    created_after: createdAfter,
    limit: clampListLimit(options.limit)
  })
  let result = rows
  if (state === 'pending') {
    result = result.filter(row => row.expires_at === null || row.expires_at > now)
  }
  // Hide retired (legacy) kinds by default unless an explicit item_kind filter
  // or include_retired opts them back in (task #2125).
  if (itemKind === undefined && !includeRetired) {
    result = result.filter(row => !isLegacyItemKind(row.item_kind))
  }
  return result
}

export function rejectPlacementProposalService(proposalId: string, options: RejectOptions = {}, d: Database = getDb()): PlacementProposalRow {
  const existing = getProposal(d, proposalId)
  if (!existing) throw new NotFoundError(`placement proposal '${proposalId}' not found`)
  if (existing.state !== 'pending') {
    throw new ValidationError(`placement proposal '${proposalId}' is '${existing.state}', not 'pending'`)
  }
  const updated = updateProposalState(d, proposalId, {
    state: 'rejected',
    decided_at: options.now ?? new Date().toISOString(),
    decided_by: options.decidedBy ?? null
  })
  if (!updated) throw new NotFoundError(`placement proposal '${proposalId}' not found`)
  return updated
}

export function isProposalStale(row: PlacementProposalRow, d: Database = getDb()): boolean {
  return pairFingerprint(d, row.source_thought_id, row.target_id) !== row.fingerprint
}
