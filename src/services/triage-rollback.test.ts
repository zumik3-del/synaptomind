/**
 * Rollback round-trip coverage for triage rows (task #1004).
 *
 * Covers activate→draft, archive→draft, edge-deletion-only-for-created-edges,
 * fingerprint-drift skip, merge refusal, and rolled-back state shape.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { closeDb, getDb } from '../db'
import { getThoughtRow } from '../db/thoughts'
import { createTestDb, seedThought } from '../test/helpers'
import { applyProposal } from './placement-apply.service'
import { rollback } from './placement-rollback.service'
import {
  assertAccepted,
  assertRolledBack,
  NOW,
  NOW_LATER,
  PAST,
  RUN_ID,
  insertPendingTriage,
} from './triage-apply-helpers'

beforeEach(createTestDb)
afterEach(closeDb)

// ── helpers ────────────────────────────────────────────────────────────────────

function appliedActivateRow(db: Database, sourceId: string): { rowId: string; sourceId: string } {
  const row = insertPendingTriage(db, 'triage_activate', sourceId)
  const out = applyProposal(row.id, { confirm: true, now: NOW, runId: RUN_ID }, db)
  expect(out.status).toBe('accepted')
  assertAccepted(db, row.id)
  return { rowId: row.id, sourceId }
}

function appliedArchiveRow(db: Database, sourceId: string, targetId: string): { rowId: string; sourceId: string } {
  const row = insertPendingTriage(db, 'triage_archive', sourceId, targetId)
  const out = applyProposal(row.id, { confirm: true, now: NOW, runId: RUN_ID }, db)
  expect(out.status).toBe('accepted')
  assertAccepted(db, row.id)
  return { rowId: row.id, sourceId }
}

// ── activate → source back to draft ────────────────────────────────────────────

describe('rollback: triage_activate round-trip', () => {
  test('source returns to draft after rollback', () => {
    const db = getDb()
    const s = seedThought({ id: 'rb-act-s', content: 'activate src', status: 'draft', created_at: NOW })
    const { rowId } = appliedActivateRow(db, s)
    expect(getThoughtRow(db, s)!.status).toBe('active')

    const report = rollback(RUN_ID, { confirm: true, now: NOW_LATER }, db)
    expect(report.summary.reverted).toBe(1)
    expect(report.summary.skipped).toBe(0)
    expect(report.summary.refused).toBe(0)
    expect(getThoughtRow(db, s)!.status).toBe('draft')
    assertRolledBack(db, rowId)
  })

  test('dry-run does not mutate the graph or the queue', () => {
    const db = getDb()
    const s = seedThought({ id: 'rb-act-dr-s', content: 'dry activate', status: 'draft', created_at: NOW })
    const { rowId } = appliedActivateRow(db, s)
    expect(getThoughtRow(db, s)!.status).toBe('active')

    const report = rollback(RUN_ID, { confirm: false, now: NOW_LATER }, db)
    expect(report.confirm).toBe(false)
    expect(report.summary.reverted).toBe(1) // dry-run still reports what would happen
    // Graph unchanged.
    expect(getThoughtRow(db, s)!.status).toBe('active')
    // Row remains accepted (not rolled_back).
    assertAccepted(db, rowId)
  })
})

// ── archive → source back to draft ─────────────────────────────────────────────

describe('rollback: triage_archive round-trip', () => {
  test('source returns to draft after rollback', () => {
    const db = getDb()
    const s = seedThought({ id: 'rb-arc-s', content: 'archive src', status: 'draft', created_at: NOW })
    const t = seedThought({ id: 'rb-arc-t', content: 'archive tgt', status: 'active', created_at: PAST })
    const { rowId } = appliedArchiveRow(db, s, t)
    expect(getThoughtRow(db, s)!.status).toBe('archived')

    const report = rollback(RUN_ID, { confirm: true, now: NOW_LATER }, db)
    expect(report.summary.reverted).toBe(1)
    expect(getThoughtRow(db, s)!.status).toBe('draft')
    assertRolledBack(db, rowId)
  })
})

// ── only edges created by the run are deleted ──────────────────────────────────

describe('rollback: edge scope', () => {
  test('an unrelated edge in the graph survives rollback of a triage row', () => {
    const db = getDb()
    const s = seedThought({ id: 'rb-edge-s', content: 'edge src', status: 'draft', created_at: NOW })
    const t = seedThought({ id: 'rb-edge-t', content: 'edge tgt', status: 'active', created_at: PAST })
    // Create an edge outside the triage run.
    db.prepare(
      "INSERT INTO edges (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, 'related', ?)"
    ).run(`edge-rb-${s}`, s, t, NOW)

    const { rowId } = appliedActivateRow(db, s)
    const beforeEdges = db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }

    const report = rollback(RUN_ID, { confirm: true, now: NOW_LATER }, db)
    expect(report.summary.reverted).toBe(1)

    const afterEdges = db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }
    expect(afterEdges.n).toBe(beforeEdges.n) // unrelated edge preserved
    assertRolledBack(db, rowId)
  })
})

// ── fingerprint-drifted rows are skipped with a warning ────────────────────────

describe('rollback: fingerprint drift', () => {
  test('drifted source is skipped (not reverted), row stays accepted', () => {
    const db = getDb()
    const s = seedThought({ id: 'rb-drift-s', content: 'drift src', status: 'draft', created_at: NOW })
    const { rowId } = appliedActivateRow(db, s)
    // Mutate the source after apply to drift the fingerprint.
    db.prepare("UPDATE thoughts SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(s)

    const report = rollback(RUN_ID, { confirm: true, now: NOW_LATER }, db)
    expect(report.summary.reverted).toBe(0)
    expect(report.summary.skipped).toBe(1)
    expect(report.items[0].action).toBe('skipped')
    expect(report.items[0].reason).toContain('fingerprint')
    // Source stays active (not reverted).
    expect(getThoughtRow(db, s)!.status).toBe('active')
    // Row stays accepted (not rolled_back) — skipped rows don't change state.
    assertAccepted(db, rowId)
  })
})

// ── merge rows are refused ─────────────────────────────────────────────────────

describe('rollback: merge refusal', () => {
  test('a lifecycle/merge row in the same run is refused, other items still revert', () => {
    const db = getDb()
    const s = seedThought({ id: 'rb-merge-s', content: 'merge src', status: 'draft', created_at: NOW })
    const t = seedThought({ id: 'rb-merge-t', content: 'merge tgt', status: 'active', created_at: PAST })
    // Apply an activate for s first.
    const { rowId: actRowId } = appliedActivateRow(db, s)
    // Insert and apply a merge lifecycle item under the same run.
    const mergeRowId = `row-merge-rb-${s}`
    db.prepare(`
      INSERT INTO placement_proposals
        (id, project_id, source_thought_id, item_kind, target_id, edge_type, lifecycle_action, direction,
         confidence, rationale, rule_id, payload, fingerprint, state, created_at, run_id, decided_at, applied_at, result)
      VALUES (?, 'default', ?, 'lifecycle', ?, null, 'merge', null,
              0.9, 'merge test', null, '{}', 'merge-fp', 'accepted', ?, ?, ?, ?, ?)
    `).run(mergeRowId, s, t, NOW, RUN_ID, NOW, NOW, JSON.stringify({ idempotent: false }))

    const report = rollback(RUN_ID, { confirm: true, now: NOW_LATER }, db)
    expect(report.summary.refused).toBe(1)
    expect(report.summary.reverted).toBe(1)
    expect(report.items.some(i => i.action === 'refused' && i.reason?.includes('merge'))).toBe(true)
    // The activate row was still reverted.
    expect(getThoughtRow(db, s)!.status).toBe('draft')
    assertRolledBack(db, actRowId)
  })
})

// ── rolled_back row shape ──────────────────────────────────────────────────────

describe('rollback: row state after revert', () => {
  test('rolled_back rows have non-null decided_at', () => {
    const db = getDb()
    const s = seedThought({ id: 'rb-shape-s', content: 'shape src', status: 'draft', created_at: NOW })
    const { rowId } = appliedActivateRow(db, s)
    rollback(RUN_ID, { confirm: true, now: NOW_LATER }, db)
    assertRolledBack(db, rowId)
  })
})

// ── Mixed run: activate + archive ──────────────────────────────────────────────

describe('rollback: mixed run', () => {
  test('both activate and archive in one run revert correctly', () => {
    const db = getDb()
    const s1 = seedThought({ id: 'rb-mix-s1', content: 'mix activate', status: 'draft', created_at: NOW })
    const s2 = seedThought({ id: 'rb-mix-s2', content: 'mix archive', status: 'draft', created_at: NOW })
    const t2 = seedThought({ id: 'rb-mix-t2', content: 'mix archive tgt', status: 'active', created_at: PAST })
    const { rowId: actRowId } = appliedActivateRow(db, s1)
    const { rowId: arcRowId } = appliedArchiveRow(db, s2, t2)

    const report = rollback(RUN_ID, { confirm: true, now: NOW_LATER }, db)
    expect(report.summary.reverted).toBe(2)
    expect(getThoughtRow(db, s1)!.status).toBe('draft')
    expect(getThoughtRow(db, s2)!.status).toBe('draft')
    assertRolledBack(db, actRowId)
    assertRolledBack(db, arcRowId)
  })
})
