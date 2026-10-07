/**
 * `PlacementPlan` → persisted-item mapping and fingerprints for the
 * placement-proposal queue (ADR 2026-09-28 P8, §2.2–2.5 / R3).
 *
 * Pure mapping layer extracted from `placement-proposals.service.ts`: it turns
 * a propose-only `PlacementPlan` into the internal `MappedItem` shapes the
 * service inserts, and computes the sha1 staleness fingerprint (ADR §2.3).
 * Read-only with respect to the graph — it never calls a graph writer.
 */

import { createHash } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { getEdgePairBetween } from '../db/edges'
import type { PlacementProposalRow, ProposalItemKind } from '../db/placement-proposals'
import { getThoughtRow, type Thought } from '../db/thoughts'
import { ValidationError } from '../errors'
import type { EdgeProposal, LifecycleProposal, PlacementPlan, PlacementProposal } from './placement/types'

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
  itemKind: ProposalItemKind
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
 * (`isProposalStale`), the apply path's post-writer snapshot, and triage
 * enqueue. `targetId: null` fingerprints the source alone.
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

function placementItem(d: Database, source: Thought, placement: PlacementProposal): MappedItem | undefined {
  const fingerprint = fingerprintPair(d, source, placement.target_id)
  if (!fingerprint) return undefined
  return {
    itemKind: 'placement',
    targetId: placement.target_id,
    edgeType: placement.kind === 'cluster' ? 'cluster' : 'parent',
    lifecycleAction: null,
    direction: 'directed',
    confidence: placement.confidence,
    rationale: placement.rationale,
    ruleId: null,
    payload: JSON.stringify({ kind: placement.kind, review_required: placement.review_required }),
    fingerprint
  }
}

/**
 * The lifecycle item target: the superseded older target for
 * `replaces+archive` (ADR R1), the near-duplicate for `merge`. Falls back to
 * the owned `replaces` edge target when the plan predates `target_id`.
 */
function lifecycleTarget(lifecycle: LifecycleProposal, replacesEdge: EdgeProposal | undefined): string | undefined {
  if (lifecycle.target_id !== undefined) return lifecycle.target_id
  if (lifecycle.action === 'replaces+archive') return replacesEdge?.target_id
  return undefined
}

function lifecycleItem(
  d: Database,
  source: Thought,
  lifecycle: LifecycleProposal,
  replacesEdge: EdgeProposal | undefined
): MappedItem | undefined {
  if (lifecycle.action !== 'merge' && lifecycle.action !== 'replaces+archive') return undefined
  const targetId = lifecycleTarget(lifecycle, replacesEdge)
  if (targetId === undefined) {
    throw new ValidationError(`lifecycle '${lifecycle.action}' proposal has no target to enqueue`)
  }
  const fingerprint = fingerprintPair(d, source, targetId)
  if (!fingerprint) return undefined
  return {
    itemKind: 'lifecycle',
    targetId,
    edgeType: lifecycle.action === 'replaces+archive' ? 'replaces' : null,
    lifecycleAction: lifecycle.action,
    direction: null,
    confidence: lifecycle.confidence,
    rationale: lifecycle.rationale,
    ruleId: lifecycle.action === 'replaces+archive' ? (replacesEdge?.rule_id ?? null) : null,
    payload: JSON.stringify({ review_required: lifecycle.review_required, blocked_by: lifecycle.blocked_by }),
    fingerprint
  }
}

/**
 * Map one `PlacementPlan` to its persisted items (ADR §2.2). `keep`/`link`
 * produce no lifecycle item; a `replaces+archive` lifecycle owns its pair, so
 * the corresponding `replaces` edge item is emitted only through the lifecycle.
 */
export function mapPlan(d: Database, source: Thought, plan: PlacementPlan): MappedItem[] {
  const replacesEdge = plan.edges.find(
    e => e.type === 'replaces' && e.rule_id === 'supersede.newer_replaces_older'
  )
  const ownedTarget = plan.lifecycle.action === 'replaces+archive'
    ? lifecycleTarget(plan.lifecycle, replacesEdge)
    : undefined

  const items: MappedItem[] = []
  for (const edge of plan.edges) {
    if (ownedTarget !== undefined && edge.type === 'replaces' && edge.target_id === ownedTarget) continue
    const item = edgeItem(d, source, edge)
    if (item) items.push(item)
  }
  if (plan.placement) {
    const item = placementItem(d, source, plan.placement)
    if (item) items.push(item)
  }
  const lifecycle = lifecycleItem(d, source, plan.lifecycle, replacesEdge)
  if (lifecycle) items.push(lifecycle)
  return items
}
