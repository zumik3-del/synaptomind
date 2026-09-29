/**
 * Helpers shared across triage-apply / triage-gates / triage-rollback suites.
 */
import { expect } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { getThoughtRow } from '../db/thoughts'
import { insertProposal, type PlacementProposalRow } from '../db/placement-proposals'
import { computeFingerprint } from './placement-proposals.service'

export const NOW = '2026-01-01T00:00:00.000Z'
export const NOW_LATER = '2026-02-01T00:00:00.000Z'
export const PAST = '2025-01-01T00:00:00.000Z'
export const FUTURE = '2027-01-01T00:00:00.000Z'
export const RUN_ID = 'run-triage-001'

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

/** Insert a pending triage row whose fingerprint matches the live snapshot. */
export function insertPendingTriage(
  db: Database,
  itemKind: 'triage_activate' | 'triage_archive',
  sourceId: string,
  targetId: string | null = null
): PlacementProposalRow {
  const ruleId = itemKind === 'triage_activate' ? 'default.activate' : 'duplicate.active_near_duplicate'
  const payload = JSON.stringify({
    verdict: itemKind === 'triage_activate' ? 'activate' : 'archive',
    reason: 'test gate',
    overlap: null,
    rule_id: ruleId,
    review_required: true,
  })
  const fingerprint = pairFingerprint(db, sourceId, targetId)
  return insertProposal(db, {
    project_id: 'default',
    source_thought_id: sourceId,
    item_kind: itemKind,
    target_id: targetId,
    edge_type: null,
    lifecycle_action: null,
    direction: null,
    confidence: 0.5,
    rationale: 'test gate',
    rule_id: ruleId,
    payload,
    fingerprint,
    expires_at: null,
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
