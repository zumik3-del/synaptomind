import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb } from '../test/helpers'
import { getDb } from './container'
import { closeDb, initDb } from './init'
import v042 from './migrations/v042-is-global'

// Migration coverage for the is_global flag (epic #1489). Mirrors the v041
// migration test conventions (src/db/placement-proposals-v041.test.ts).

const MEM_OPTS = { isMemory: true, dimensions: 384 }

beforeEach(createTestDb)
afterEach(closeDb)

// ── v042 migration: fresh DB ─────────────────────────────────────────────────

test('v042: is_global column present on thoughts after fresh migration', () => {
  const cols = getDb().prepare(`PRAGMA table_info(thoughts)`).all() as { name: string }[]
  expect(cols.map(c => c.name)).toContain('is_global')
})

test('v042: is_global is INTEGER NOT NULL DEFAULT 0', () => {
  const cols = getDb().prepare(`PRAGMA table_info(thoughts)`).all() as Array<{
    name: string
    type: string
    notnull: number
    dflt_value: string | null
  }>
  const col = cols.find(c => c.name === 'is_global')
  expect(col).toBeDefined()
  expect(col!.type).toBe('INTEGER')
  expect(col!.notnull).toBe(1)
  expect(col!.dflt_value).toBe('0')
})

test('v042: schema_version is 42 after fresh init', () => {
  const row = getDb()
    .prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`)
    .get() as { value: string } | undefined
  expect(row?.value).toBe('42')
})

test('v042: a row inserted without is_global defaults to 0', () => {
  const db = getDb()
  const now = new Date().toISOString()
  // Omit is_global entirely so the column DEFAULT is the only source of truth.
  db.prepare(
    `INSERT INTO thoughts (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run('v042-default-row', 'default row', now, now)
  const row = db
    .prepare(`SELECT is_global FROM thoughts WHERE id = ?`)
    .get('v042-default-row') as { is_global: number }
  expect(row.is_global).toBe(0)
})

// ── v042 migration: apply() probe path (legacy DB lacking the column) ────────

test('v042: apply() adds is_global to a legacy thoughts table lacking it', () => {
  const db = new Database(':memory:')
  try {
    // Minimal legacy table without is_global — the ADD COLUMN branch.
    db.exec(`CREATE TABLE thoughts (id TEXT PRIMARY KEY)`)
    v042.apply(db, MEM_OPTS)
    const cols = db.prepare(`PRAGMA table_info(thoughts)`).all() as { name: string }[]
    expect(cols.map(c => c.name)).toContain('is_global')
  } finally {
    db.close()
  }
})

test('v042: apply() is idempotent — a second run neither throws nor duplicates the column', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`CREATE TABLE thoughts (id TEXT PRIMARY KEY)`)
    v042.apply(db, MEM_OPTS)
    v042.apply(db, MEM_OPTS) // column probe must skip the ALTER
    const cols = db.prepare(`PRAGMA table_info(thoughts)`).all() as { name: string }[]
    expect(cols.filter(c => c.name === 'is_global')).toHaveLength(1)
  } finally {
    db.close()
  }
})

// ── v042 migration: re-init idempotency ──────────────────────────────────────

test('v042: re-running init on the same DB keeps is_global and schema_version 42', () => {
  initDb({ dbPath: ':memory:', runMigrations: true })
  const db2 = getDb()
  const cols = db2.prepare(`PRAGMA table_info(thoughts)`).all() as { name: string }[]
  expect(cols.map(c => c.name)).toContain('is_global')
  const row = db2
    .prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`)
    .get() as { value: string } | undefined
  expect(row?.value).toBe('42')
})
