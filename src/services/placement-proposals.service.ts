/**
 * Persisted placement-proposal queue (ADR 2026-09-28 P8, §2.2–2.4 / R3).
 *
 * Read-only with respect to the graph: this module maps a `PlacementPlan`
 * (produced by the propose-only engine) to rows in `placement_proposals` and
 * manages the review worklist (`list`/`reject`). It never calls a graph writer;
 * applying a queued item is R4 (`placement-apply.service.ts`).
 *
 * Mapping (ADR §2.2, §2.5):
 *  - every emitted `EdgeProposal` → one `edge` item;
 *  - the `PlacementProposal` (cluster or parent) → one `placement` item;
 *  - `merge` / `replaces+archive` → one `lifecycle` item. `keep` (nothing) and
 *    `link` (already represented by the edge items) are not queued as lifecycle.
 *  - a `replaces+archive` lifecycle **owns** its pair: the matching `replaces`
 *    edge item is not enqueued a second time.
 *
 * Staleness (ADR §2.3): every row stores a `fingerprint` of the exact graph
 * snapshot an apply would touch. Re-enqueue refreshes the live row (dedup is
 * enforced by the partial unique index, `db/placement-proposals.ts`); `list`
 * hides terminal/expired rows by default.
 */

import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { getDb } from '../db'
import { getEdgePairBetween } from '../db/edges'
import {
  getProposal,
  insertProposal,
  listProposals,
  updateProposalState,
  type InsertProposalInput,
  type PlacementProposalRow,
  type ProposalItemKind,
  type ProposalState
} from '../db/placement-proposals'
import { getThoughtRow, type Thought } from '../db/thoughts'
import { NotFoundError, ValidationError } from '../errors'
import { DRAFT_THOUGHT_ID, proposePlacementPlan } from './placement/engine'
import type { PlacementPlan } from './placement/types'
import {
  computeFingerprint,
  itemKey,
  mapPlan,
  proposalExpiry,
  toItemKey
} from './placement-proposals.mapping'

export { computeFingerprint } from './placement-proposals.mapping'
export type { FingerprintInput } from './placement-proposals.mapping'

export interface EnqueuePlanOptions {
  /** Clock override for deterministic tests (default now). */
  now?: string
}

export interface EnqueueThoughtOptions {
  /** Project scope for neighbour recall (defaults to the thought's project). */
  projectId?: string
  /** Clock override for deterministic tests (default now). */
  now?: string
}

export interface ListOptions {
  /** State filter; defaults to live `pending` rows (ADR §2.2). */
  state?: ProposalState
  projectId?: string
  /** Optional item-kind filter, e.g. `triage_activate` (ADR 2026-09-29 §2.7). */
  itemKind?: ProposalItemKind
  limit?: number
  /** Clock override for the expired-row filter (default now). */
  now?: string
}

export interface RejectOptions {
  /** Agent/tool that rejected the item (audit, ADR §2.8). */
  decidedBy?: string
  now?: string
}

/**
 * Enqueue every confirmable item of `plan` (ADR §2.2–2.4). Re-enqueueing the
 * same item refreshes the live pending row (dedup via `insertProposal`);
 * enqueueing a *new* item while `maxPendingProposals` live rows exist throws.
 * Drafts cannot be enqueued (ADR OQ-2) — the thought must be persisted first.
 */
export function enqueuePlan(
  plan: PlacementPlan,
  options: EnqueuePlanOptions = {},
  d: Database = getDb()
): PlacementProposalRow[] {
  const source = getThoughtRow(d, plan.thought_id)
  if (plan.thought_id === DRAFT_THOUGHT_ID || !source) {
    throw new ValidationError(
      'cannot enqueue proposals for a draft or unknown thought; persist the thought first'
    )
  }

  const now = options.now ?? new Date().toISOString()
  const items = mapPlan(d, source, plan)
  if (items.length === 0) return []

  const maxPending = config.placement.maxPendingProposals
  const expiresAt = proposalExpiry(now)
  const projectId = source.project_id ?? null

  const run = d.transaction(() => {
    // Count only live (non-expired) pending rows so overdue rows do not
    // consume the cap; the retention job marks them expired (ADR §2.4).
    const pending = listProposals(d, { state: 'pending', limit: maxPending + items.length + 1 })
      .filter(row => row.expires_at === null || row.expires_at > now)
    const keys = new Set(pending.map(toItemKey))
    let pendingCount = pending.length

    const rows: PlacementProposalRow[] = []
    for (const item of items) {
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

  return run()
}

/**
 * Propose a read-only placement plan for a persisted thought and enqueue its
 * confirmable items (ADR §2.9 / R5). The surface stays thin behind this
 * service call; drafts are rejected (OQ-2) because both the engine's draft
 * sentinel and `enqueuePlan` refuse a non-persisted source.
 */
export async function enqueueThoughtProposals(
  thoughtId: string,
  options: EnqueueThoughtOptions = {},
  d: Database = getDb()
): Promise<PlacementProposalRow[]> {
  const plan = await proposePlacementPlan(
    { thoughtId, projectId: options.projectId },
    { projectId: options.projectId, now: options.now },
    {},
    d
  )
  return enqueuePlan(plan, { now: options.now }, d)
}

/**
 * List proposals newest first (ADR §2.2, §2.9). Defaults to live `pending`
 * rows and drops pending rows whose `expires_at` has passed, so terminal and
 * expired proposals are excluded unless an explicit `state` is requested.
 */
export function list(options: ListOptions = {}, d: Database = getDb()): PlacementProposalRow[] {
  const state = options.state ?? 'pending'
  const now = options.now ?? new Date().toISOString()
  const rows = listProposals(d, {
    state,
    project_id: options.projectId,
    item_kind: options.itemKind,
    limit: options.limit ?? 100
  })
  if (state !== 'pending') return rows
  return rows.filter(row => row.expires_at === null || row.expires_at > now)
}

/**
 * Transition a live `pending` proposal to `rejected` (ADR §2.2). Terminal rows
 * cannot be rejected again; unknown ids throw `NotFoundError`.
 */
export function reject(proposalId: string, options: RejectOptions = {}, d: Database = getDb()): PlacementProposalRow {
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

/**
 * Read-time staleness check (ADR §2.3): recompute the fingerprint from the
 * current graph snapshot and compare it to the one stored at enqueue. A
 * missing source/target, a changed `updated_at`/`status`, or a newly appeared
 * edge on the pair all make the proposal stale.
 */
export function isProposalStale(row: PlacementProposalRow, d: Database = getDb()): boolean {
  const source = getThoughtRow(d, row.source_thought_id)
  if (!source) return true

  let target: Thought | undefined
  if (row.target_id !== null) {
    target = getThoughtRow(d, row.target_id)
    if (!target) return true
  }

  const existingEdgeType =
    row.target_id !== null ? (getEdgePairBetween(d, row.source_thought_id, row.target_id)?.type ?? null) : null

  const current = computeFingerprint({
    sourceId: source.id,
    sourceUpdatedAt: source.updated_at,
    sourceStatus: source.status,
    targetId: target?.id ?? '',
    targetUpdatedAt: target?.updated_at ?? '',
    targetStatus: target?.status ?? '',
    existingEdgeType
  })
  return current !== row.fingerprint
}
