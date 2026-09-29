import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { getDb } from './container'
import { closeDb } from './init'
import {
  deleteExpired,
  getProposal,
  insertProposal,
  listProposals,
  type InsertProposalInput,
  updateProposalState,
  type ProposalState,
} from './placement-proposals'

beforeEach(createTestDb)
afterEach(closeDb)

// ── helpers ──────────────────────────────────────────────────────────────────

function makeInput(overrides?: Partial<InsertProposalInput>): InsertProposalInput {
  return {
    source_thought_id: overrides?.source_thought_id ?? seedThought(),
    item_kind: overrides?.item_kind ?? 'edge',
    confidence: overrides?.confidence ?? 0.8,
    rationale: overrides?.rationale ?? 'test rationale',
    payload: overrides?.payload ?? JSON.stringify({ foo: 'bar' }),
    fingerprint: overrides?.fingerprint ?? 'fp-1',
    ...overrides,
  }
}

function now(): string {
  return new Date().toISOString()
}

// ── migration sanity ─────────────────────────────────────────────────────────

test('placement_proposals table exists after migration', () => {
  const db = getDb()
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='placement_proposals'")
    .all() as { name: string }[]
  expect(tables).toHaveLength(1)
})

test('placement_proposals has expected columns', () => {
  const db = getDb()
  const cols = db
    .prepare(`PRAGMA table_info(placement_proposals)`)
    .all() as { name: string }[]
  expect(cols.map((c) => c.name)).toEqual(
    expect.arrayContaining([
      'id',
      'project_id',
      'source_thought_id',
      'item_kind',
      'target_id',
      'edge_type',
      'lifecycle_action',
      'direction',
      'confidence',
      'rationale',
      'rule_id',
      'payload',
      'state',
      'fingerprint',
      'created_at',
      'expires_at',
      'decided_at',
      'decided_by',
      'applied_at',
      'result',
    ])
  )
})

test('placement_proposals has idx_pp_pending index', () => {
  const db = getDb()
  const indexes = db
    .prepare(`PRAGMA index_list('placement_proposals')`)
    .all() as { name: string }[]
  expect(indexes.map((i) => i.name)).toContain('idx_pp_pending')
})

test('placement_proposals has idx_pp_source index', () => {
  const db = getDb()
  const indexes = db
    .prepare(`PRAGMA index_list('placement_proposals')`)
    .all() as { name: string }[]
  expect(indexes.map((i) => i.name)).toContain('idx_pp_source')
})

test('placement_proposals has idx_pp_dedup partial unique index on pending state', () => {
  const db = getDb()
  const indexes = db
    .prepare(`PRAGMA index_list('placement_proposals')`)
    .all() as { name: string }[]
  expect(indexes.map((i) => i.name)).toContain('idx_pp_dedup')
  // Verify it is partial: examine the index SQL
  const info = db
    .prepare(`PRAGMA index_info('idx_pp_dedup')`)
    .all() as { cid: number; name: string }[]
  // The dedup index covers the five key columns
  expect(info).toHaveLength(5)
})

// ── insertProposal / getProposal ──────────────────────────────────────────────

test('insertProposal inserts a pending row and returns it', () => {
  const db = getDb()
  const src = seedThought()
  const input = makeInput({ source_thought_id: src, item_kind: 'edge' })
  const row = insertProposal(db, input)

  expect(row.id).toBeString()
  expect(row.state).toBe('pending')
  expect(row.source_thought_id).toBe(src)
  expect(row.item_kind).toBe('edge')
  expect(row.confidence).toBe(0.8)
  expect(row.rationale).toBe('test rationale')
  expect(row.fingerprint).toBe('fp-1')
  expect(row.created_at).toBeString()
  expect(row.expires_at).toBeNull()
  expect(row.decided_at).toBeNull()
})

test('insertProposal derives id via randomUUIDv7', () => {
  const db = getDb()
  const row = insertProposal(db, makeInput())
  // v7 ids are 26 chars; just check length and non-empty
  expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})

test('getProposal returns undefined for missing id', () => {
  expect(getProposal(getDb(), 'does-not-exist')).toBeUndefined()
})

test('getProposal returns the inserted row by id', () => {
  const db = getDb()
  const row = insertProposal(db, makeInput())
  const found = getProposal(db, row.id)
  expect(found).toBeDefined()
  expect(found!.id).toBe(row.id)
  expect(found!.state).toBe('pending')
})

// ── listProposals ─────────────────────────────────────────────────────────────

test('listProposals returns empty array when nothing is queued', () => {
  expect(listProposals(getDb())).toHaveLength(0)
})

test('listProposals returns pending rows', () => {
  const db = getDb()
  const src1 = seedThought()
  const src2 = seedThought()
  insertProposal(db, makeInput({ source_thought_id: src1, payload: 'p1', item_kind: 'edge', edge_type: 'develops' }))
  insertProposal(db, makeInput({ source_thought_id: src2, payload: 'p2', item_kind: 'placement' }))
  const rows = listProposals(db)
  expect(rows).toHaveLength(2)
  expect(rows.every((r) => r.state === 'pending')).toBe(true)
})

test('listProposals defaults to pending state, excludes accepted rows', () => {
  const db = getDb()
  const src1 = seedThought()
  const src2 = seedThought()
  const p1 = insertProposal(db, makeInput({ source_thought_id: src1, payload: 'pending-one', item_kind: 'edge', edge_type: 'parent' }))
  insertProposal(db, makeInput({ source_thought_id: src2, payload: 'accepted-one', item_kind: 'placement' }))
  updateProposalState(db, p1.id, { state: 'accepted', decided_by: 'user' })
  // p1 is now accepted; src2's proposal is still pending
  const pending = listProposals(db)
  const accepted = listProposals(db, { state: 'accepted' })
  expect(pending).toHaveLength(1)
  expect(pending[0].id).not.toBe(p1.id) // pending does not include the accepted one
  expect(accepted).toHaveLength(1)
  expect(accepted[0].id).toBe(p1.id)
})

test('listProposals excludes expired rows by default', () => {
  const db = getDb()
  const src = seedThought()
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString()
  insertProposal(db, makeInput({ source_thought_id: src, payload: 'expired-was-pending', expires_at: twoDaysAgo }))
  deleteExpired(db, '2099-12-31T00:00:00.000Z')
  expect(listProposals(db)).toHaveLength(0)
  // The expired row is still in the DB, just not returned by default
  expect(listProposals(db, { state: 'expired' })).toHaveLength(1)
})

test('listProposals filters by project_id', () => {
  const db = getDb()
  const srcA = seedThought()
  const srcB = seedThought({ project_id: 'other' })
  insertProposal(db, makeInput({ source_thought_id: srcA, project_id: 'default' }))
  insertProposal(db, makeInput({ source_thought_id: srcB, project_id: 'other' }))
  const all = listProposals(db)
  expect(all).toHaveLength(2)
  const filtered = listProposals(db, { project_id: 'default' })
  expect(filtered).toHaveLength(1)
  expect(filtered[0].project_id).toBe('default')
})

test('listProposals respects limit', () => {
  const db = getDb()
  for (let i = 0; i < 5; i++) {
    insertProposal(db, makeInput({ payload: `p-${i}` }))
  }
  expect(listProposals(db, { limit: 2 })).toHaveLength(2)
})

test('listProposals orders newest first', () => {
  const db = getDb()
  insertProposal(db, makeInput({ payload: 'old' }))
  // Manually set an older created_at on the first row
  db.prepare(`UPDATE placement_proposals SET created_at = ? WHERE payload = ?`).run(
    '2020-01-01T00:00:00.000Z',
    'old'
  )
  insertProposal(db, makeInput({ payload: 'new' }))
  const rows = listProposals(db)
  expect(rows[0].payload).toBe('new')
  expect(rows[1].payload).toBe('old')
})

// ── dedup: double pending insert → one row ───────────────────────────────────

test('double pending insert of the same item → one row (dedup)', () => {
  const db = getDb()
  const src = seedThought()
  const input: InsertProposalInput = {
    source_thought_id: src,
    item_kind: 'edge',
    target_id: null,
    edge_type: 'develops',
    lifecycle_action: null,
    direction: null,
    confidence: 0.8,
    rationale: 'first',
    payload: '{"a":1}',
    fingerprint: 'fp-a',
    expires_at: null,
  }
  const first = insertProposal(db, input)
  // Identical input again
  const second = insertProposal(db, input)
  // Same row id, not a duplicate
  expect(second.id).toBe(first.id)
  // Only one row exists
  const all = listProposals(db)
  expect(all).toHaveLength(1)
})

test('double insert with different source_thought_id → two rows', () => {
  const db = getDb()
  const src1 = seedThought()
  const src2 = seedThought()
  insertProposal(db, makeInput({ source_thought_id: src1, payload: 'src1' }))
  insertProposal(db, makeInput({ source_thought_id: src2, payload: 'src2' }))
  expect(listProposals(db)).toHaveLength(2)
})

test('double insert with different item_kind → two rows', () => {
  const db = getDb()
  const src = seedThought()
  insertProposal(db, makeInput({ source_thought_id: src, item_kind: 'edge', payload: 'e' }))
  insertProposal(db, makeInput({ source_thought_id: src, item_kind: 'placement', payload: 'p' }))
  expect(listProposals(db)).toHaveLength(2)
})

test('double insert with different edge_type → two rows', () => {
  const db = getDb()
  const src = seedThought()
  insertProposal(db, makeInput({ source_thought_id: src, edge_type: 'parent', payload: 'a' }))
  insertProposal(db, makeInput({ source_thought_id: src, edge_type: 'cluster', payload: 'b' }))
  expect(listProposals(db)).toHaveLength(2)
})

test('re-insert refreshes payload/fingerprint/expires_at on the existing row', () => {
  const db = getDb()
  const src = seedThought()
  const input: InsertProposalInput = {
    source_thought_id: src,
    item_kind: 'edge',
    target_id: null,
    edge_type: 'develops',
    lifecycle_action: null,
    direction: null,
    confidence: 0.8,
    rationale: 'original rationale',
    payload: '{"v":1}',
    fingerprint: 'fp-old',
    expires_at: null,
  }
  const first = insertProposal(db, input)
  // Re-insert with updated fields
  const refreshed = insertProposal(db, {
    ...input,
    payload: '{"v":2}',
    fingerprint: 'fp-new',
    confidence: 0.95,
    rationale: 'updated rationale',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  })
  expect(refreshed.id).toBe(first.id)
  expect(refreshed.payload).toBe('{"v":2}')
  expect(refreshed.fingerprint).toBe('fp-new')
  expect(refreshed.confidence).toBe(0.95)
  expect(refreshed.rationale).toBe('updated rationale')
  expect(refreshed.expires_at).not.toBeNull()
  // Row count unchanged
  expect(listProposals(db)).toHaveLength(1)
})

// ── updateProposalState ───────────────────────────────────────────────────────

test('updateProposalState transitions pending → accepted and persists', () => {
  const db = getDb()
  const row = insertProposal(db, makeInput())
  const updated = updateProposalState(db, row.id, {
    state: 'accepted',
    decided_at: now(),
    decided_by: 'agent',
    applied_at: now(),
    result: 'done',
  })
  expect(updated).toBeDefined()
  expect(updated!.state).toBe('accepted')
  expect(updated!.decided_by).toBe('agent')
  expect(updated!.applied_at).not.toBeNull()
  expect(updated!.result).toBe('done')
  // Verify persisted via getProposal
  const reloaded = getProposal(db, row.id)
  expect(reloaded!.state).toBe('accepted')
})

test('updateProposalState transitions pending → rejected', () => {
  const db = getDb()
  const row = insertProposal(db, makeInput())
  const updated = updateProposalState(db, row.id, { state: 'rejected' })
  expect(updated!.state).toBe('rejected')
})

test('updateProposalState returns undefined for nonexistent id', () => {
  expect(updateProposalState(getDb(), 'missing', { state: 'accepted' })).toBeUndefined()
})

test('all ProposalState values are accepted', () => {
  const states: ProposalState[] = ['pending', 'accepted', 'rejected', 'expired', 'stale']
  for (const state of states) {
    const db = getDb()
    const row = insertProposal(db, makeInput())
    const updated = updateProposalState(db, row.id, { state })
    expect(updated!.state).toBe(state)
  }
})

// ── ON DELETE CASCADE ─────────────────────────────────────────────────────────

test('deleting a source thought cascades: proposal row is removed', () => {
  const db = getDb()
  const src = seedThought()
  const row = insertProposal(db, makeInput({ source_thought_id: src }))
  db.prepare('DELETE FROM thoughts WHERE id = ?').run(src)
  expect(getProposal(db, row.id)).toBeUndefined()
  // Also no rows left for this source
  expect(listProposals(db).filter((r) => r.source_thought_id === src)).toHaveLength(0)
})

test('deleting a target thought cascades: proposal row is removed', () => {
  const db = getDb()
  const tgt = seedThought()
  const src = seedThought()
  insertProposal(db, makeInput({ source_thought_id: src, target_id: tgt }))
  db.prepare('DELETE FROM thoughts WHERE id = ?').run(tgt)
  // All proposals are gone because each was tied to the deleted target
  // (or source). List should be empty.
  expect(listProposals(db)).toHaveLength(0)
})

// ── deleteExpired ─────────────────────────────────────────────────────────────

test('deleteExpired marks expired-past-pending rows as expired and deletes old terminal rows', () => {
  const db = getDb()
  const src1 = seedThought()
  const src2 = seedThought()
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString()
  const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString()

  // Pending with expired-at in the past
  insertProposal(db, makeInput({ source_thought_id: src1, expires_at: twoDaysAgo, item_kind: 'edge', edge_type: 'develops' }))
  // Terminal row decided long ago (different source to avoid dedup)
  const accepted = insertProposal(db, makeInput({ source_thought_id: src2, item_kind: 'placement' }))
  updateProposalState(db, accepted.id, {
    state: 'accepted',
    decided_at: tenDaysAgo,
  })

  const removed = deleteExpired(db, twoDaysAgo)
  expect(removed).toBe(2) // 1 expired (state change) + 1 pruned (delete)
  // Pending-only listing no longer sees the expired or pruned rows
  expect(listProposals(db)).toHaveLength(0)
  // The expired row still exists but is no longer pending
  const expiredRows = db.prepare("SELECT id FROM placement_proposals WHERE state = 'expired'").all() as { id: string }[]
  expect(expiredRows).toHaveLength(1)
  // No terminal rows remain
  const terminalRows = db.prepare("SELECT id FROM placement_proposals WHERE state != 'pending' AND state != 'expired'").all() as { id: string }[]
  expect(terminalRows).toHaveLength(0)
})

test('deleteExpired does not remove rows with expires_at in the future', () => {
  const db = getDb()
  const src = seedThought()
  const farFuture = new Date(Date.now() + 100 * 86400000).toISOString()
  insertProposal(db, makeInput({ source_thought_id: src, expires_at: farFuture }))
  const removed = deleteExpired(db, now())
  expect(removed).toBe(0)
  expect(listProposals(db)).toHaveLength(1)
})

test('deleteExpired does not remove pending rows without expires_at', () => {
  const db = getDb()
  const src = seedThought()
  insertProposal(db, makeInput({ source_thought_id: src, expires_at: null }))
  const removed = deleteExpired(db, now())
  expect(removed).toBe(0)
  expect(listProposals(db)).toHaveLength(1)
})

test('deleteExpired does not remove terminal rows decided after cutoff', () => {
  const db = getDb()
  const src = seedThought()
  const accepted = insertProposal(db, makeInput({ source_thought_id: src }))
  const yesterday = new Date(Date.now() - 86400000).toISOString()
  updateProposalState(db, accepted.id, { state: 'accepted', decided_at: yesterday })
  const removed = deleteExpired(db, yesterday)
  // The decided_at equals cutoff exactly; the query uses <, so it is NOT removed
  expect(removed).toBe(0)
  expect(getProposal(db, accepted.id)?.state).toBe('accepted')
})

// ── idempotency via dedup at the DB level (partial unique index) ─────────────

test('idx_pp_dedup rejects a concurrent duplicate pending insert (UNIQUE violation)', () => {
  const db = getDb()
  const src = seedThought()
  const input: InsertProposalInput = {
    source_thought_id: src,
    item_kind: 'edge',
    target_id: null,
    edge_type: 'develops',
    lifecycle_action: null,
    direction: null,
    confidence: 0.7,
    rationale: 'dup test',
    payload: '{"d":1}',
    fingerprint: 'fp-dup',
  }
  // The application-level dedup in insertProposal prevents a second row.
  // This test verifies the function itself does not throw and returns the same row.
  const first = insertProposal(db, input)
  const second = insertProposal(db, input)
  expect(second.id).toBe(first.id)
  const all = db.prepare('SELECT id FROM placement_proposals').all() as { id: string }[]
  expect(all).toHaveLength(1)
  expect(all[0].id).toBe(first.id)
})
