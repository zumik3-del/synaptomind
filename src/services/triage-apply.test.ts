/**
 * Apply dry-run, idempotency, run-provenance, and batch coverage for triage
 * rows (task #1000, ADR §2.3.4).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { closeDb, getDb } from '../db'
import { getThoughtRow } from '../db/thoughts'
import { createTestDb, seedThought } from '../test/helpers'
import { applyProposal, applyBatch } from './placement-apply.service'
import {
  assertAccepted,
  assertStillPending,
  NOW,
  NOW_LATER,
  PAST,
  insertPendingTriage,
} from './triage-apply-helpers'

beforeEach(createTestDb)
afterEach(closeDb)

// ── dry-run: triage_activate ──────────────────────────────────────────────────

describe('dry-run: triage_activate', () => {
  test('dry-run returns planned calls without mutating the queue or the graph', () => {
    const db = getDb()
    const s = seedThought({ id: 'dr-act-s', content: 'dry src', status: 'draft', created_at: NOW })
    const row = insertPendingTriage(db, 'triage_activate', s)
    const out = applyProposal(row.id, { now: NOW }, db)
    expect(out.status).toBe('dry_run')
    expect((out as { calls: Array<{ writer: string }> }).calls).toHaveLength(1)
    expect((out as { calls: Array<{ writer: string }> }).calls[0].writer).toBe('updateThoughtById')
    assertStillPending(db, row.id)
    expect(getThoughtRow(db, s)!.status).toBe('draft')
  })

  test('dry-run surfaces stale gate without mutating the queue', () => {
    const db = getDb()
    const s = seedThought({ id: 'dr-act-stale', content: 'stale src', status: 'archived', created_at: PAST })
    const row = insertPendingTriage(db, 'triage_activate', s)
    const out = applyProposal(row.id, { now: NOW }, db)
    expect(out.status).toBe('stale')
    assertStillPending(db, row.id)
  })
})

// ── dry-run: triage_archive ───────────────────────────────────────────────────

describe('dry-run: triage_archive', () => {
  test('dry-run returns planned calls without mutating the queue or the graph', () => {
    const db = getDb()
    const s = seedThought({ id: 'dr-arc-s', content: 'dry src', status: 'draft', created_at: NOW })
    const t = seedThought({ id: 'dr-arc-t', content: 'dry tgt', status: 'active', created_at: PAST })
    const row = insertPendingTriage(db, 'triage_archive', s, t)
    const out = applyProposal(row.id, { now: NOW }, db)
    expect(out.status).toBe('dry_run')
    expect((out as { calls: Array<{ writer: string }> }).calls).toHaveLength(1)
    expect((out as { calls: Array<{ writer: string }> }).calls[0].writer).toBe('archiveThoughtById')
    assertStillPending(db, row.id)
    expect(getThoughtRow(db, s)!.status).toBe('draft')
  })

  test('dry-run surfaces stale gate when target is archived', () => {
    const db = getDb()
    const s = seedThought({ id: 'dr-arc-stale-s', content: 'src', status: 'draft', created_at: NOW })
    const t = seedThought({ id: 'dr-arc-stale-t', content: 'archived tgt', status: 'archived', created_at: PAST })
    const row = insertPendingTriage(db, 'triage_archive', s, t)
    const out = applyProposal(row.id, { now: NOW }, db)
    expect(out.status).toBe('stale')
    assertStillPending(db, row.id)
  })
})

// ── idempotency: triage rows ──────────────────────────────────────────────────

describe('idempotency: triage rows', () => {
  test('re-applying an already-accepted triage_activate row returns accepted/idempotent without calling a writer', () => {
    const db = getDb()
    const s = seedThought({ id: 'idem-act-s', content: 'idem src', status: 'draft', created_at: NOW })
    const row = insertPendingTriage(db, 'triage_activate', s)
    const first = applyProposal(row.id, { confirm: true, now: NOW, runId: 'run-1' }, db)
    expect(first.status).toBe('accepted')
    assertAccepted(db, row.id)
    const second = applyProposal(row.id, { confirm: true, now: NOW_LATER, runId: 'run-1' }, db)
    expect(second.status).toBe('accepted')
    expect((second as { idempotent: boolean }).idempotent).toBe(true)
    expect((second as { calls: unknown[] }).calls).toEqual([])
    assertAccepted(db, row.id)
  })

  test('re-applying an already-accepted triage_archive row returns accepted/idempotent', () => {
    const db = getDb()
    const s = seedThought({ id: 'idem-arc-s', content: 'idem src', status: 'draft', created_at: NOW })
    const t = seedThought({ id: 'idem-arc-t', content: 'idem tgt', status: 'active', created_at: PAST })
    const row = insertPendingTriage(db, 'triage_archive', s, t)
    applyProposal(row.id, { confirm: true, now: NOW, runId: 'run-2' }, db)
    assertAccepted(db, row.id)
    const second = applyProposal(row.id, { confirm: true, now: NOW_LATER, runId: 'run-2' }, db)
    expect(second.status).toBe('accepted')
    expect((second as { idempotent: boolean }).idempotent).toBe(true)
    expect((second as { calls: unknown[] }).calls).toEqual([])
  })
})

// ── run provenance ────────────────────────────────────────────────────────────

describe('run provenance', () => {
  test('apply(triage_activate) persists run_id and a triage envelope result', () => {
    const db = getDb()
    const s = seedThought({ id: 'prov-act-s', content: 'prov src', status: 'draft', created_at: NOW })
    const row = insertPendingTriage(db, 'triage_activate', s)
    const out = applyProposal(row.id, { confirm: true, now: NOW, runId: 'run-prov-1' }, db) as { status: string; result: string | null }
    expect(out.status).toBe('accepted')
    expect(out.result).not.toBeNull()
    const envelope = JSON.parse(out.result!) as Record<string, unknown>
    expect(envelope.run_id).toBe('run-prov-1')
    expect(envelope.before_status).toBe('draft')
    expect(envelope.after_status).toBe('active')
    expect(envelope.rule_id).toBe('default.activate')
    expect(envelope.target_id).toBeNull()
    expect(getThoughtRow(db, s)!.status).toBe('active')
  })

  test('apply(triage_archive) persists run_id and a triage envelope result', () => {
    const db = getDb()
    const s = seedThought({ id: 'prov-arc-s', content: 'prov src', status: 'draft', created_at: NOW })
    const t = seedThought({ id: 'prov-arc-t', content: 'prov tgt', status: 'active', created_at: PAST })
    const row = insertPendingTriage(db, 'triage_archive', s, t)
    const out = applyProposal(row.id, { confirm: true, now: NOW, runId: 'run-prov-2' }, db) as { status: string; result: string | null }
    expect(out.status).toBe('accepted')
    expect(out.result).not.toBeNull()
    const envelope = JSON.parse(out.result!) as Record<string, unknown>
    expect(envelope.run_id).toBe('run-prov-2')
    expect(envelope.before_status).toBe('draft')
    expect(envelope.after_status).toBe('archived')
    expect(envelope.rule_id).toBe('duplicate.active_near_duplicate')
    expect(envelope.target_id).toBe(t)
    expect(getThoughtRow(db, s)!.status).toBe('archived')
  })
})

// ── batch apply: triage rows ──────────────────────────────────────────────────

describe('applyBatch: triage rows', () => {
  test('mixed triage_activate and triage_archive in one batch', () => {
    const db = getDb()
    const s1 = seedThought({ id: 'bat-act-s', content: 'batch activate src', status: 'draft', created_at: NOW })
    const s2 = seedThought({ id: 'bat-arc-s', content: 'batch archive src', status: 'draft', created_at: NOW })
    const t2 = seedThought({ id: 'bat-arc-t', content: 'batch archive tgt', status: 'active', created_at: PAST })
    const row1 = insertPendingTriage(db, 'triage_activate', s1)
    const row2 = insertPendingTriage(db, 'triage_archive', s2, t2)
    const out = applyBatch([row1.id, row2.id], { confirm: true, now: NOW, runId: 'run-batch-1' }, db)
    expect(out.errors).toHaveLength(0)
    expect(out.results).toHaveLength(2)
    const statuses = out.results.map(r => r.status)
    expect(statuses).toContain('accepted')
    assertAccepted(db, row1.id)
    assertAccepted(db, row2.id)
  })

  test('partial failure: one stale sibling does not block the other', () => {
    const db = getDb()
    const sOk = seedThought({ id: 'bat-ok-s', content: 'ok src', status: 'draft', created_at: NOW })
    const sStale = seedThought({ id: 'bat-stale-s', content: 'stale src', status: 'archived', created_at: PAST })
    const rowOk = insertPendingTriage(db, 'triage_activate', sOk)
    const rowStale = insertPendingTriage(db, 'triage_activate', sStale)
    const out = applyBatch([rowOk.id, rowStale.id], { confirm: true, now: NOW, runId: 'run-batch-2' }, db)
    expect(out.errors).toHaveLength(0)
    expect(out.results).toHaveLength(2)
    const statuses = out.results.map(r => r.status)
    expect(statuses).toContain('accepted')
    expect(statuses).toContain('stale')
    assertAccepted(db, rowOk.id)
  })
})

// ── TTL and structural guards at the apply seam ───────────────────────────────

describe('apply: TTL and structural guards', () => {
  test('an overdue row is refused before the retention sweep runs', () => {
    const db = getDb()
    const s = seedThought({ id: 'ttl-apply-s', content: 'overdue src', status: 'draft', created_at: NOW })
    const row = insertPendingTriage(db, 'triage_activate', s)
    // Retention only hides overdue rows from `list`; knowing the id must not be
    // enough to confirm one.
    db.prepare('UPDATE placement_proposals SET expires_at = ? WHERE id = ?').run(PAST, row.id)

    const out = applyProposal(row.id, { confirm: true, now: NOW, runId: 'run-ttl' }, db)
    expect(out.status).toBe('stale')
    expect(getThoughtRow(db, s)!.status).toBe('draft')

    const stored = db.prepare('SELECT state FROM placement_proposals WHERE id = ?').get(row.id) as { state: string }
    expect(stored.state).toBe('stale')
  })

  test('an overdue row is refused in dry-run too', () => {
    const db = getDb()
    const s = seedThought({ id: 'ttl-dry-s', content: 'overdue dry src', status: 'draft', created_at: NOW })
    const row = insertPendingTriage(db, 'triage_activate', s)
    db.prepare('UPDATE placement_proposals SET expires_at = ? WHERE id = ?').run(PAST, row.id)
    expect(applyProposal(row.id, { now: NOW }, db).status).toBe('stale')
    assertStillPending(db, row.id)
  })

  test('an overdue row is not idempotently accepted into a run manifest', () => {
    const db = getDb()
    const s = seedThought({ id: 'ttl-early-s', content: 'early src', status: 'active', created_at: PAST })
    const row = insertPendingTriage(db, 'triage_activate', s)
    db.prepare('UPDATE placement_proposals SET expires_at = ? WHERE id = ?').run(PAST, row.id)

    const out = applyProposal(row.id, { confirm: true, now: NOW, runId: 'run-ttl-early' }, db)
    expect(out.status).toBe('stale')
    // No phantom accepted row: the run manifest must not gain an entry for a
    // mutation that never happened, or rollback would try to invert it.
    const manifest = db.prepare("SELECT COUNT(*) AS n FROM placement_proposals WHERE run_id = 'run-ttl-early' AND state = 'accepted'").get() as { n: number }
    expect(manifest.n).toBe(0)
  })

  test('a triage_archive row without a target cannot archive the draft', () => {
    const db = getDb()
    const s = seedThought({ id: 'notgt-apply-s', content: 'no target src', status: 'draft', created_at: NOW })
    const row = insertPendingTriage(db, 'triage_archive', s, null)
    const out = applyProposal(row.id, { confirm: true, now: NOW, runId: 'run-notgt' }, db)
    expect(out.status).toBe('failed')
    expect(getThoughtRow(db, s)!.status).toBe('draft')
  })
})
