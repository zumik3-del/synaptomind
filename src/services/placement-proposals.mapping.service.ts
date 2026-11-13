import { createHash } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { MS_PER_DAY } from '../utils'
import { getEdgePairBetween } from '../db/edges'
import type {
  LegacyProposalItemKind,
  PlacementProposalRow,
  ProposalItemKind,
  StoredProposalItemKind
} from '../db/placement-proposals'
import { getThoughtRow, type Thought } from '../db/thoughts'
import type { EdgeProposal, PlacementPlan } from './placement/types'

export interface FingerprintInput {
  sourceId: string
  sourceUpdatedAt: string
  sourceStatus: string
  targetId: string
  targetUpdatedAt: string
  targetStatus: string
  existingEdgeType: string | null
}

interface MappedItem {
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

export interface SkippedPlanItem {
  kind: LegacyProposalItemKind
  reason: string
}

export interface MappedPlan {
  items: MappedItem[]
  skipped: SkippedPlanItem[]
}

// Field order is the stored-fingerprint contract: changing it invalidates every queued row.
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

export function proposalExpiry(now: string): string | null {
  const ttlDays = config.placement.proposalTtlDays
  if (ttlDays < 0) return null
  return new Date(Date.parse(now) + ttlDays * MS_PER_DAY).toISOString()
}

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

export function pairFingerprint(d: Database, sourceId: string, targetId: string | null): string {
  const source = getThoughtRow(d, sourceId)
  const target = targetId !== null ? getThoughtRow(d, targetId) : undefined
  const existingEdgeType =
    targetId !== null ? (getEdgePairBetween(d, sourceId, targetId)?.type ?? null) : null
  return assembleFingerprint(source, target, sourceId, targetId ?? '', existingEdgeType)
}

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

export function countSkippedKinds(skipped: SkippedPlanItem[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of skipped) {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1
  }
  return counts
}
