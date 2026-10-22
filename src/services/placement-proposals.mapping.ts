/**
 * `PlacementPlan` → persisted-item mapping and fingerprints for the
 * placement-proposal queue (ADR 2026-09-28 P8, §2.2–2.5 / R3).
 *
 * Pure mapping layer extracted from `placement-proposals.service.ts`: it turns
 * a propose-only `PlacementPlan` into the internal `MappedItem` shapes the
 * service inserts, and computes the sha1 staleness fingerprint (ADR §2.3).
 * Read-only with respect to the graph — it never calls a graph writer.
 *
 * Since task #1942 the queue only creates `edge` items. A plan's `placement`
 * proposal and its queueable `lifecycle` action are reported as *skipped*
 * instead of being mapped, so the caller can report them instead of dropping
 * them silently.
 */

import { createHash } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { getEdgePairBetween } from '../db/edges'
import type {
  LegacyProposalItemKind,
  PlacementProposalRow,
  ProposalItemKind,
  StoredProposalItemKind
} from '../db/placement-proposals'
import { getThoughtRow, type Thought } from '../db/thoughts'
import type { EdgeProposal, PlacementPlan } from './placement/types'

/** The exact inputs an apply would touch — the staleness key (ADR §2.3). */
export interface FingerprintInput {
  sourceId: string
  sourceUpdatedAt: string
  sourceStatus: string
  targetId: string
  targetUpdatedAt: string
  targetStatus: string
  existingEdgeType: string | null
}

/** Internal per-item shape before it becomes an `InsertProposalInput`. */
export interface MappedItem {
  itemKind: ProposalItemKind
  targetId: string
  edgeType: string | null
  lifecycleAction: string | null
  direction: string | null
  confidence: number
  rationale: string
  ruleId: string | null
  payload: string
  fingerprint: string
}

/**
 * A plan item the queue no longer creates (task #1942): its kind was removed
 * from the queue, so it is reported as skipped instead of being mapped.
 */
export interface SkippedPlanItem {
  kind: LegacyProposalItemKind
  /** Why the item was skipped — reported back to the caller. */
  reason: string
}

/** The result of mapping one plan: the queueable items plus the skipped ones. */
export interface MappedPlan {
  /** The items the queue can still create — `edge` items only (task #1942). */
  items: MappedItem[]
  /** The plan items that were not mapped because their kind is no longer supported. */
  skipped: SkippedPlanItem[]
}

/**
 * sha1 over the canonical snapshot string (ADR §2.3):
 * `source.id:source.updated_at:source.status:target.id:target.updated_at:target.status:existingEdgeType`.
 * Pure, so the same graph snapshot always yields the same fingerprint.
 */
export function computeFingerprint(input: FingerprintInput): string {
  const raw = [
    input.sourceId,
    input.sourceUpdatedAt,
    input.sourceStatus,
    input.targetId,
    input.targetUpdatedAt,
    input.targetStatus,
    input.existingEdgeType ?? 'none'
  ].join(':')
  return createHash('sha1').update(raw).digest('hex')
}

/** Canonical dedup key matching the partial unique index `idx_pp_dedup`. */
export function itemKey(parts: {
  sourceId: string
  itemKind: StoredProposalItemKind
  targetId: string | null
  edgeType: string | null
  lifecycleAction: string | null
}): string {
  return [
    parts.sourceId,
    parts.itemKind,
    parts.targetId ?? '',
    parts.edgeType ?? '',
    parts.lifecycleAction ?? ''
  ].join('|')
}

export function toItemKey(row: PlacementProposalRow): string {
  return itemKey({
    sourceId: row.source_thought_id,
    itemKind: row.item_kind,
    targetId: row.target_id,
    edgeType: row.edge_type,
    lifecycleAction: row.lifecycle_action
  })
}

/** `expires_at` for a newly enqueued/refreshed row; `null` disables expiry. */
export function proposalExpiry(now: string): string | null {
  const ttlDays = config.placement.proposalTtlDays
  if (ttlDays < 0) return null
  return new Date(Date.parse(now) + ttlDays * 86400000).toISOString()
}

/**
 * The single snapshot → sha1 assembly (ADR §2.3). A missing row contributes
 * empty fields, which can never equal a stored fingerprint — every enqueued row
 * was fingerprinted while its source and target existed.
 */
function assembleFingerprint(
  source: Thought | undefined,
  target: Thought | undefined,
  sourceId: string,
  targetId: string,
  existingEdgeType: string | null
): string {
  return computeFingerprint({
    sourceId: source?.id ?? sourceId,
    sourceUpdatedAt: source?.updated_at ?? '',
    sourceStatus: source?.status ?? '',
    targetId: target?.id ?? targetId,
    targetUpdatedAt: target?.updated_at ?? '',
    targetStatus: target?.status ?? '',
    existingEdgeType
  })
}

/**
 * Fingerprint of a (source, target) pair from the current DB snapshot (ADR
 * §2.3) — the one read-time derivation, shared by the queue's staleness check
 * (`isProposalStale`), the apply path's post-writer snapshot and the rollback
 * gate. `targetId: null` fingerprints the source alone.
 */
export function pairFingerprint(d: Database, sourceId: string, targetId: string | null): string {
  const source = getThoughtRow(d, sourceId)
  const target = targetId !== null ? getThoughtRow(d, targetId) : undefined
  const existingEdgeType = targetId !== null ? (getEdgePairBetween(d, sourceId, targetId)?.type ?? null) : null
  return assembleFingerprint(source, target, sourceId, targetId ?? '', existingEdgeType)
}

/** Fingerprint of a (source, target) pair, or `undefined` when the target is gone. */
function fingerprintPair(d: Database, source: Thought, targetId: string): string | undefined {
  const target = getThoughtRow(d, targetId)
  if (!target) return undefined
  const existing = getEdgePairBetween(d, source.id, targetId)?.type ?? null
  return assembleFingerprint(source, target, source.id, targetId, existing)
}

function edgeItem(d: Database, source: Thought, edge: EdgeProposal): MappedItem | undefined {
  const fingerprint = fingerprintPair(d, source, edge.target_id)
  if (!fingerprint) return undefined
  return {
    itemKind: 'edge',
    targetId: edge.target_id,
    edgeType: edge.type,
    lifecycleAction: null,
    direction: edge.direction,
    confidence: edge.confidence,
    rationale: edge.rationale,
    ruleId: edge.rule_id,
    payload: JSON.stringify({ review_required: edge.review_required, signals: edge.signals }),
    fingerprint
  }
}

/**
 * Map one `PlacementPlan` to its persisted items (ADR §2.2). Since task #1942
 * only the plan's `edge` proposals are mapped; the `placement` proposal and a
 * queueable `lifecycle` action (`merge` / `replaces+archive`) are reported as
 * skipped, so the caller can tell the user what was dropped.
 *
 * A `replaces+archive` lifecycle no longer owns its `replaces` edge — with the
 * lifecycle kind gone the edge is an ordinary `edge` item again.
 */
export function mapPlan(d: Database, source: Thought, plan: PlacementPlan): MappedPlan {
  const skipped: SkippedPlanItem[] = []
  if (plan.placement) {
    skipped.push({
      kind: 'placement',
      reason: `placement proposal ('${plan.placement.kind}') is no longer queued`
    })
  }
  if (plan.lifecycle.action === 'merge' || plan.lifecycle.action === 'replaces+archive') {
    skipped.push({
      kind: 'lifecycle',
      reason: `lifecycle '${plan.lifecycle.action}' is no longer queued`
    })
  }

  const items: MappedItem[] = []
  for (const edge of plan.edges) {
    const item = edgeItem(d, source, edge)
    if (item) items.push(item)
  }
  return { items, skipped }
}

/** The skipped plan items grouped by kind — the report the enqueue surfaces. */
export function countSkippedKinds(skipped: SkippedPlanItem[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of skipped) {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1
  }
  return counts
}
