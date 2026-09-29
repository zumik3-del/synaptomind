import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { getDb } from './container'
import { closeDb, initDb } from './init'
import {
  insertProposal,
  listProposalsByRun,
  type InsertProposalInput,
  updateProposalState,
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

// ── v041 migration: fresh DB ─────────────────────────────────────────────────

test('v041: run_id column present on placement_proposals after fresh migration', () => {
  const db = getDb()
  const cols = db
    .prepare(`PRAGMA table_info(placement_proposals)`)
    .all() as { name: string }[]
  expect(cols.map((c) => c.name)).toContain('run_id')
})

test('v041: idx_pp_run index exists after fresh migration', () => {
  const db = getDb()
  const indexes = db
    .prepare(`PRAGMA index_list('placement_proposals')`)
    .all() as { name: string }[]
  expect(indexes.map((i) => i.name)).toContain('idx_pp_run')
})

test('v041: idx_pp_run covers (run_id, state) columns', () => {
  const db = getDb()
  const info = db
    .prepare(`PRAGMA index_info('idx_pp_run')`)
    .all() as { cid: number; name: string }[]
  const colNames = info.map((i) => i.name)
  expect(colNames).toContain('run_id')
  expect(colNames).toContain('state')
  expect(info).toHaveLength(2)
})

test('v041: schema_version is 41 after fresh init', () => {
  const db = getDb()
  const row = db
    .prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`)
    .get() as { value: string } | undefined
  expect(row?.value).toBe('41')
})

// ── v041 migration: idempotent re-run ────────────────────────────────────────

test('v041: re-running init on same in-memory DB is idempotent', () => {
  const db = getDb()
  // Save the schema version before re-init
  const before = db
    .prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`)
    .get() as { value: string } | undefined
  expect(before?.value).toBe('41')

  // Re-initialize with the same :memory: path — this should not throw
  // and should leave schema intact.
  initDb({ dbPath: ':memory:', runMigrations: true })
  const db2 = getDb()
  const after = db2
    .prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`)
    .get() as { value: string } | undefined
  expect(after?.value).toBe('41')

  // run_id column still present
  const cols = db2
    .prepare(`PRAGMA table_info(placement_proposals)`)
    .all() as { name: string }[]
  expect(cols.map((c) => c.name)).toContain('run_id')
  // index still present
  const indexes = db2
    .prepare(`PRAGMA index_list('placement_proposals')`)
    .all() as { name: string }[]
  expect(indexes.map((i) => i.name)).toContain('idx_pp_run')
})

// ── run_id persistence via insertProposal ────────────────────────────────────

test('v041: insertProposal stores run_id when provided', () => {
  const db = getDb()
  const runId = 'run-abc-123'
  const row = insertProposal(db, makeInput({ run_id: runId }))
  expect(row.run_id).toBe(runId)
})

test('v041: insertProposal stores null run_id by default', () => {
  const db = getDb()
  const row = insertProposal(db, makeInput())
  expect(row.run_id).toBeNull()
})

// ── dedup unchanged with distinct run_id ─────────────────────────────────────

test('v041: distinct run_id does NOT create a second live pending row for the same dedup key', () => {
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
    rationale: 'dedup test',
    payload: '{"d":1}',
    fingerprint: 'fp-dedup',
    expires_at: null,
  }
  const first = insertProposal(db, { ...input, run_id: 'run-1' })
  const second = insertProposal(db, { ...input, run_id: 'run-2' })
  // Same row — dedup path refreshes, not inserts
  expect(second.id).toBe(first.id)
  // run_id is NOT updated on the refresh path (only payload/fingerprint/etc.)
  expect(first.run_id).toBe('run-1')
  // Only one row exists total
  expect(db.prepare('SELECT COUNT(*) AS c FROM placement_proposals').get() as { c: number }).toEqual({ c: 1 })
})

// ── updateProposalState: run_id COALESCE behavior ────────────────────────────

test('v041: updateProposalState with omitted run_id preserves existing run_id', () => {
  const db = getDb()
  const row = insertProposal(db, makeInput({ run_id: 'run-preserves' }))
  const updated = updateProposalState(db, row.id, { state: 'accepted' })
  expect(updated!.run_id).toBe('run-preserves')
})

test('v041: updateProposalState with explicit run_id overwrites existing value', () => {
  const db = getDb()
  const row = insertProposal(db, makeInput({ run_id: 'run-old' }))
  const updated = updateProposalState(db, row.id, { state: 'rejected', run_id: 'run-new' })
  expect(updated!.run_id).toBe('run-new')
})

test('v041: updateProposalState with explicit null run_id preserves existing value (COALESCE)', () => {
  const db = getDb()
  const row = insertProposal(db, makeInput({ run_id: 'run-preserves' }))
  // COALESCE(null, run_id) preserves the existing value — null input is indistinguishable from omitting run_id
  const updated = updateProposalState(db, row.id, { state: 'expired', run_id: null })
  expect(updated!.run_id).toBe('run-preserves')
})

// ── new ProposalItemKind values round-trip ───────────────────────────────────

test('v041: triage_activate kind round-trips through insert/list', () => {
  const db = getDb()
  const row = insertProposal(db, makeInput({ item_kind: 'triage_activate' }))
  expect(row.item_kind).toBe('triage_activate')
  const found = db
    .prepare("SELECT item_kind FROM placement_proposals WHERE id = ?")
    .get(row.id) as { item_kind: string }
  expect(found.item_kind).toBe('triage_activate')
})

test('v041: triage_archive kind round-trips through insert/list', () => {
  const db = getDb()
  const row = insertProposal(db, makeInput({ item_kind: 'triage_archive' }))
  expect(row.item_kind).toBe('triage_archive')
  const found = db
    .prepare("SELECT item_kind FROM placement_proposals WHERE id = ?")
    .get(row.id) as { item_kind: string }
  expect(found.item_kind).toBe('triage_archive')
})

// ── new ProposalState value round-trips ──────────────────────────────────────

test('v041: rolled_back state round-trips through update/list', () => {
  const db = getDb()
  const row = insertProposal(db, makeInput())
  const updated = updateProposalState(db, row.id, { state: 'rolled_back' })
  expect(updated!.state).toBe('rolled_back')
  const found = db
    .prepare("SELECT state FROM placement_proposals WHERE id = ?")
    .get(row.id) as { state: string }
  expect(found.state).toBe('rolled_back')
})

// ── listProposalsByRun ───────────────────────────────────────────────────────

test('v041: listProposalsByRun returns exactly that run\'s rows, newest-first', () => {
  const db = getDb()
  const src1 = seedThought()
  const src2 = seedThought()
  const src3 = seedThought()
  const runA = 'run-a'
  const runB = 'run-b'

  // Insert in run-A (older)
  const oldA = insertProposal(db, makeInput({ source_thought_id: src1, run_id: runA, payload: 'a-old' }))
  // Manual delay to ensure different created_at
  db.prepare(`UPDATE placement_proposals SET created_at = ? WHERE id = ?`).run(
    '2020-01-01T00:00:00.000Z',
    oldA.id
  )

  // Insert in run-B
  const bRow = insertProposal(db, makeInput({ source_thought_id: src2, run_id: runB, payload: 'b-only' }))

  // Insert in run-A (newer)
  const newA = insertProposal(db, makeInput({ source_thought_id: src3, run_id: runA, payload: 'a-new' }))

  const rowsA = listProposalsByRun(db, runA)
  expect(rowsA).toHaveLength(2)
  expect(rowsA[0].id).toBe(newA.id) // newest first
  expect(rowsA[1].id).toBe(oldA.id)
  expect(rowsA.every((r) => r.run_id === runA)).toBe(true)

  const rowsB = listProposalsByRun(db, runB)
  expect(rowsB).toHaveLength(1)
  expect(rowsB[0].id).toBe(bRow.id)
})

test('v041: listProposalsByRun spans all states for the given run', () => {
  const db = getDb()
  const src = seedThought()
  const runId = 'run-states'
  const row = insertProposal(db, makeInput({ source_thought_id: src, run_id: runId }))
  updateProposalState(db, row.id, { state: 'accepted', decided_at: new Date().toISOString() })

  const rows = listProposalsByRun(db, runId)
  expect(rows).toHaveLength(1)
  expect(rows[0].state).toBe('accepted')
  expect(rows[0].run_id).toBe(runId)
})

test('v041: listProposalsByRun returns empty array for unknown run', () => {
  const db = getDb()
  expect(listProposalsByRun(db, 'nonexistent-run')).toEqual([])
})
