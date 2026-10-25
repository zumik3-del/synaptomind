/**
 * Helpers shared across the apply / rollback suites.
 */
import { expect } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { getEdgePairBetween } from '../db/edges'
import { getThoughtRow } from '../db/thoughts'
import { insertProposal, type PlacementProposalRow } from '../db/placement-proposals'
import { computeFingerprint } from '../services/placement-proposals.service'

export const NOW = '2026-01-01T00:00:00.000Z'
/**
 * A second clock reading 19 days after `NOW` — deliberately INSIDE the F-14
 * rollback window. `rollback` refuses an accepted row decided more than
 * `placement.proposalTtlDays` (default 30 d) before `now`, so widening this gap
 * past 30 days puts every rollback fixture out of window. The out-of-window
 * cases are pinned on purpose in `placement-rollback.service.test.ts`; these
 * shared fixtures must keep the ordinary round-trips in-window.
 */
export const NOW_LATER = '2026-01-20T00:00:00.000Z'
export const PAST = '2025-01-01T00:00:00.000Z'
export const FUTURE = '2027-01-01T00:00:00.000Z'
export const RUN_ID = 'run-apply-001'

/** Fingerprint of a (source, optional-target) pair from the live DB. */
export function pairFingerprint(db: Database, sourceId: string, targetId: string | null): string {
  const source = getThoughtRow(db, sourceId)!
  if (!targetId) {
    return computeFingerprint({
      sourceId,
      sourceUpdatedAt: source.updated_at,
      sourceStatus: source.status,
      targetId: '',
      targetUpdatedAt: '',
      targetStatus: '',
      existingEdgeType: null,
    })
  }
  const target = getThoughtRow(db, targetId)
  if (!target) throw new Error(`target thought '${targetId}' not found`)
  return computeFingerprint({
    sourceId,
    sourceUpdatedAt: source.updated_at,
    sourceStatus: source.status,
    targetId,
    targetUpdatedAt: target.updated_at,
    targetStatus: target.status,
    existingEdgeType: null,
  })
}

/**
 * Fingerprint of a (source, target) pair INCLUDING the live edge between them —
 * the exact shape `isProposalStale` recomputes
 * (`placement-proposals.service.ts:250-262`). An edge-producing proposal must be
 * enqueued against that snapshot or its own gate call reports it as drifted.
 */
function edgePairFingerprint(db: Database, sourceId: string, targetId: string): string {
  const source = getThoughtRow(db, sourceId)
  if (!source) throw new Error(`source thought '${sourceId}' not found`)
  const target = getThoughtRow(db, targetId)
  if (!target) throw new Error(`target thought '${targetId}' not found`)
  return computeFingerprint({
    sourceId,
    sourceUpdatedAt: source.updated_at,
    sourceStatus: source.status,
    targetId,
    targetUpdatedAt: target.updated_at,
    targetStatus: target.status,
    existingEdgeType: getEdgePairBetween(db, sourceId, targetId)?.type ?? null,
  })
}

/** Insert a pending `edge` proposal whose fingerprint matches the live snapshot. */
export function insertPendingEdge(
  db: Database,
  sourceId: string,
  targetId: string,
  edgeType: string = 'related'
): PlacementProposalRow {
  return insertProposal(db, {
    source_thought_id: sourceId,
    item_kind: 'edge',
    target_id: targetId,
    edge_type: edgeType,
    confidence: 0.8,
    rationale: 'test edge',
    payload: '{}',
    fingerprint: edgePairFingerprint(db, sourceId, targetId),
    direction: 'symmetric',
  })
}

export function assertStillPending(db: Database, id: string): void {
  const row = db.prepare('SELECT state FROM placement_proposals WHERE id = ?').get(id) as
    | { state: string }
    | undefined
  expect(row).toBeDefined()
  expect(row!.state).toBe('pending')
}

export function assertAccepted(db: Database, id: string): void {
  const row = db.prepare('SELECT state FROM placement_proposals WHERE id = ?').get(id) as
    | { state: string }
    | undefined
  expect(row).toBeDefined()
  expect(row!.state).toBe('accepted')
}

export function assertRolledBack(db: Database, id: string): void {
  const row = db.prepare('SELECT state, decided_at FROM placement_proposals WHERE id = ?').get(id) as
    | { state: string; decided_at: string | null }
    | undefined
  expect(row).toBeDefined()
  expect(row!.state).toBe('rolled_back')
  expect(row!.decided_at).not.toBeNull()
}
