/**
 * Gate-matrix coverage for triage apply rows via real evaluateGates calls
 * (task #1004). Covers every branch in apply-gates.ts for triage_activate and
 * triage_archive, plus a static safety scan on the three modules.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { closeDb, getDb } from '../db'
import { createTestDb, seedThought } from '../test/helpers'
import { insertPendingTriage } from './triage-apply-helpers'
import { evaluateGates } from './apply-gates'
import { computeFingerprint } from './placement-proposals.service'
import type { ApplyOptions } from './placement-apply.types'
import type { PlacementProposalRow } from '../db/placement-proposals'

beforeEach(createTestDb)
afterEach(closeDb)

const NOW = '2026-01-01T00:00:00.000Z'
const PAST = '2025-01-01T00:00:00.000Z'

type GateResult = { kind: string; reason?: string }

function gate(rowId: string, options: ApplyOptions = {}): GateResult {
  const db = getDb()
  const row = db.prepare('SELECT * FROM placement_proposals WHERE id = ?').get(rowId) as PlacementProposalRow | undefined
  if (!row) throw new Error(`proposal row '${rowId}' not found`)
  return evaluateGates(row, options, db)
}

// ── triage_activate gate matrix ────────────────────────────────────────────────

describe('triage_activate gate matrix', () => {
  test('draft source → ok', () => {
    const s = seedThought({ id: 'act-ok-s', content: 'draft src', status: 'draft', created_at: NOW })
    const row = insertPendingTriage(getDb(), 'triage_activate', s)
    expect(gate(row.id)).toEqual({ kind: 'ok' })
  })

  test('source active → already_applied', () => {
    const s = seedThought({ id: 'act-act-s', content: 'active src', status: 'active', created_at: PAST })
    const row = insertPendingTriage(getDb(), 'triage_activate', s)
    expect(gate(row.id)).toEqual({ kind: 'already_applied' })
  })

  test('source archived → stale', () => {
    const s = seedThought({ id: 'act-arc-s', content: 'archived src', status: 'archived', created_at: PAST })
    const row = insertPendingTriage(getDb(), 'triage_activate', s)
    expect(gate(row.id)).toEqual({ kind: 'stale', reason: expect.stringContaining("source is 'archived', not draft") })
  })

  test('cluster source → failed', () => {
    const s = seedThought({ id: 'act-cl-s', content: 'cluster src', status: 'draft', is_cluster: 1, created_at: NOW })
    const row = insertPendingTriage(getDb(), 'triage_activate', s)
    expect(gate(row.id)).toEqual({ kind: 'failed', reason: 'cluster/profile thoughts cannot be triaged' })
  })

  test('profile source → failed', () => {
    const s = seedThought({ id: 'act-prof-s', content: 'profile src', status: 'draft', is_profile: 1, created_at: NOW })
    const row = insertPendingTriage(getDb(), 'triage_activate', s)
    expect(gate(row.id)).toEqual({ kind: 'failed', reason: 'cluster/profile thoughts cannot be triaged' })
  })

  test('scheduled reminder (pending tag) → stale', () => {
    const s = seedThought({
      id: 'act-rem-s', content: 'reminder src', status: 'draft',
      tags: '["pending"]', created_at: NOW
    })
    const row = insertPendingTriage(getDb(), 'triage_activate', s)
    expect(gate(row.id)).toEqual({ kind: 'stale', reason: expect.stringContaining('scheduled reminder') })
  })

  test('scheduled reminder (future surface_after) → stale', () => {
    const s = seedThought({
      id: 'act-fut-s', content: 'future src', status: 'draft',
      surface_after: '2027-01-01T00:00:00.000Z', created_at: NOW
    })
    const row = insertPendingTriage(getDb(), 'triage_activate', s)
    expect(gate(row.id)).toEqual({ kind: 'stale', reason: expect.stringContaining('scheduled reminder') })
  })

  test('target_id=null on triage_activate → ok (unreachable via triage producer; covered here for completeness)', () => {
    const db = getDb()
    const s = seedThought({ id: 'act-null-t-s', content: 'null target src', status: 'draft', created_at: NOW })
    const fp = computeFingerprint({
      sourceId: s, sourceUpdatedAt: NOW, sourceStatus: 'draft',
      targetId: '', targetUpdatedAt: '', targetStatus: '', existingEdgeType: null
    })
    // Insert directly with target_id=NULL to exercise the branch.
    db.prepare(`
      INSERT INTO placement_proposals
        (id, project_id, source_thought_id, item_kind, target_id, edge_type, lifecycle_action,
         direction, confidence, rationale, rule_id, payload, state, fingerprint, created_at, expires_at, run_id)
      VALUES (?, 'default', ?, 'triage_activate', NULL, NULL, NULL, NULL,
              0.5, 'test', 'default.activate', '{}', 'pending', ?, ?, NULL, NULL)
    `).run(`row-act-null-${s}`, s, fp, NOW)
    const row = db.prepare('SELECT * FROM placement_proposals WHERE id = ?').get(`row-act-null-${s}`) as PlacementProposalRow | undefined
    expect(row).toBeDefined()
    expect(gate(row!.id)).toEqual({ kind: 'ok' })
  })
})

// ── triage_archive gate matrix ─────────────────────────────────────────────────

describe('triage_archive gate matrix', () => {
  function okArchive(): { source: string; target: string; rowId: string } {
    const db = getDb()
    const s = seedThought({ id: 'arc-ok-s', content: 'draft src', status: 'draft', created_at: NOW })
    const t = seedThought({ id: 'arc-ok-t', content: 'active tgt', status: 'active', created_at: PAST })
    const row = insertPendingTriage(db, 'triage_archive', s, t)
    return { source: s, target: t, rowId: row.id }
  }

  test('draft source + active target + matching fingerprint → ok', () => {
    const { rowId } = okArchive()
    expect(gate(rowId)).toEqual({ kind: 'ok' })
  })

  test('source archived → already_applied', () => {
    const db = getDb()
    const s = seedThought({ id: 'arc-arch-s', content: 'archived src', status: 'archived', created_at: PAST })
    const t = seedThought({ id: 'arc-arch-t', content: 'active tgt', status: 'active', created_at: PAST })
    const row = insertPendingTriage(db, 'triage_archive', s, t)
    expect(gate(row.id)).toEqual({ kind: 'already_applied' })
  })

  test('target archived → stale', () => {
    const db = getDb()
    const s = seedThought({ id: 'arc-targ-arch-s', content: 'draft src', status: 'draft', created_at: NOW })
    const t = seedThought({ id: 'arc-targ-arch-t', content: 'archived tgt', status: 'archived', created_at: PAST })
    const row = insertPendingTriage(db, 'triage_archive', s, t)
    expect(gate(row.id)).toEqual({ kind: 'stale', reason: 'the target duplicate is archived' })
  })

  test('target removed (null in DB) → stale', () => {
    const db = getDb()
    const s = seedThought({ id: 'arc-targ-rm-s', content: 'draft src', status: 'draft', created_at: NOW })
    const tId = seedThought({ id: 'arc-targ-rm-t', content: 'tgt to remove', status: 'active', created_at: PAST })
    const row = insertPendingTriage(db, 'triage_archive', s, tId)
    // FK ON DELETE CASCADE would delete the proposal row; disable temporarily.
    db.run('PRAGMA foreign_keys = OFF')
    db.prepare('DELETE FROM thoughts WHERE id = ?').run(tId)
    db.run('PRAGMA foreign_keys = ON')
    expect(gate(row.id)).toEqual({ kind: 'stale', reason: 'target thought no longer exists' })
  })

  test('fingerprint mismatch (source updated_at changed) → stale', () => {
    const db = getDb()
    const s = seedThought({ id: 'arc-fp-s', content: 'fingerprint src', status: 'draft', created_at: NOW })
    const t = seedThought({ id: 'arc-fp-t', content: 'fingerprint tgt', status: 'active', created_at: PAST })
    const row = insertPendingTriage(db, 'triage_archive', s, t)
    // Mutate the source's updated_at to drift the fingerprint.
    db.prepare("UPDATE thoughts SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(s)
    expect(gate(row.id)).toEqual({ kind: 'stale', reason: 'the graph changed since the proposal was enqueued' })
  })

  test('cluster source → failed', () => {
    const db = getDb()
    const s = seedThought({ id: 'arc-cl-s', content: 'cluster src', status: 'draft', is_cluster: 1, created_at: NOW })
    const t = seedThought({ id: 'arc-cl-t', content: 'active tgt', status: 'active', created_at: PAST })
    const row = insertPendingTriage(db, 'triage_archive', s, t)
    expect(gate(row.id)).toEqual({ kind: 'failed', reason: 'cluster/profile thoughts cannot be triaged' })
  })

  test('profile source → failed', () => {
    const db = getDb()
    const s = seedThought({ id: 'arc-prof-s', content: 'profile src', status: 'draft', is_profile: 1, created_at: NOW })
    const t = seedThought({ id: 'arc-prof-t', content: 'active tgt', status: 'active', created_at: PAST })
    const row = insertPendingTriage(db, 'triage_archive', s, t)
    expect(gate(row.id)).toEqual({ kind: 'failed', reason: 'cluster/profile thoughts cannot be triaged' })
  })
})

// ── TTL and structural guards ──────────────────────────────────────────────────

describe('TTL and structural guards', () => {
  test('triage_archive with a null target → failed (no verified duplicate)', () => {
    const db = getDb()
    const s = seedThought({ id: 'arc-notgt-s', content: 'draft src', status: 'draft', created_at: NOW })
    // A malformed row: an `archive` verdict exists only because a live duplicate
    // was found, so a null target must not be able to archive a draft.
    const fp = computeFingerprint({
      sourceId: s, sourceUpdatedAt: NOW, sourceStatus: 'draft',
      targetId: '', targetUpdatedAt: '', targetStatus: '', existingEdgeType: null
    })
    const id = 'row-arc-notgt'
    db.prepare(`
      INSERT INTO placement_proposals
        (id, project_id, source_thought_id, item_kind, target_id, edge_type, lifecycle_action,
         direction, confidence, rationale, rule_id, payload, state, fingerprint, created_at, expires_at, run_id)
      VALUES (?, 'default', ?, 'triage_archive', NULL, NULL, NULL, NULL,
              0.5, 'test', 'duplicate.active_near_duplicate', '{}', 'pending', ?, ?, NULL, NULL)
    `).run(id, s, fp, NOW)
    expect(gate(id)).toEqual({ kind: 'failed', reason: 'triage_archive item has no duplicate target' })
  })

  test('an overdue row is stale even when the graph still matches', () => {
    const db = getDb()
    const s = seedThought({ id: 'ttl-s', content: 'draft src', status: 'draft', created_at: NOW })
    const row = insertPendingTriage(db, 'triage_activate', s)
    db.prepare('UPDATE placement_proposals SET expires_at = ? WHERE id = ?').run(PAST, row.id)
    // Retention only hides overdue rows; it never made them safe to apply.
    expect(gate(row.id)).toEqual({ kind: 'stale', reason: expect.stringContaining('proposal expired at') })
  })

  test('an overdue row is stale even when the requested state already holds', () => {
    const db = getDb()
    const s = seedThought({ id: 'ttl-early-s', content: 'active src', status: 'active', created_at: PAST })
    const row = insertPendingTriage(db, 'triage_activate', s)
    db.prepare('UPDATE placement_proposals SET expires_at = ? WHERE id = ?').run(PAST, row.id)
    // Expiry is checked first: an idempotent accept would inject a phantom
    // entry into a run's rollback manifest for a mutation that never happened.
    expect(gate(row.id)).toEqual({ kind: 'stale', reason: expect.stringContaining('proposal expired at') })
  })

  test('the expiry boundary matches retention: expires_at === now is still live', () => {
    const db = getDb()
    const s = seedThought({ id: 'ttl-eq-s', content: 'draft src', status: 'draft', created_at: NOW })
    const row = insertPendingTriage(db, 'triage_activate', s)
    db.prepare('UPDATE placement_proposals SET expires_at = ? WHERE id = ?').run(NOW, row.id)
    // Same strict `expires_at < now` comparison as `deleteExpired`, so the gate
    // and the retention job never disagree about which row is overdue.
    expect(gate(row.id, { now: NOW })).toEqual({ kind: 'ok' })
    expect(gate(row.id, { now: '2026-01-01T00:00:00.001Z' })).toEqual({
      kind: 'stale',
      reason: expect.stringContaining('proposal expired at')
    })
  })

  test('a row with no expires_at never expires', () => {
    const db = getDb()
    const s = seedThought({ id: 'ttl-null-s', content: 'draft src', status: 'draft', created_at: NOW })
    const row = insertPendingTriage(db, 'triage_activate', s)
    expect(gate(row.id, { now: '2099-01-01T00:00:00.000Z' })).toEqual({ kind: 'ok' })
  })
})

// ── Safety scan ────────────────────────────────────────────────────────────────

describe('safety: no deleteThought, no disallowed writer imports', () => {
  const DISALLOWED_WRITERS = ['deleteThought', 'createThought', 'deleteThoughts']

  test('apply-gates imports no graph writer', async () => {
    const src = await Bun.file(new URL('./apply-gates.ts', import.meta.url).pathname).text()
    for (const w of DISALLOWED_WRITERS) expect(src).not.toMatch(new RegExp(`\\b${w}\\b`))
  })

  test('placement-apply.service imports only the allowlisted writers', async () => {
    const src = await Bun.file(new URL('./placement-apply.service.ts', import.meta.url).pathname).text()
    for (const w of DISALLOWED_WRITERS) expect(src).not.toMatch(new RegExp(`\\b${w}\\b`))
    for (const w of ['createEdgeService', 'archiveThoughtById', 'updateThoughtById', 'mergeThoughtsService']) {
      expect(src).toMatch(new RegExp(`\\b${w}\\b`))
    }
  })

  test('placement-rollback.service imports only the allowlisted writers', async () => {
    const src = await Bun.file(new URL('./placement-rollback.service.ts', import.meta.url).pathname).text()
    for (const w of DISALLOWED_WRITERS) expect(src).not.toMatch(new RegExp(`\\b${w}\\b`))
    expect(src).toMatch(/\bdeleteEdgeService\b/)
    expect(src).toMatch(/\bupdateThoughtById\b/)
  })
})
