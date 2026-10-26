import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb } from '../test/helpers'
import { getDb } from './container'
import { closeDb } from './init'
import type { Migration } from './migrations'
import { MIGRATIONS } from './migrations'
import v043 from './migrations/v043-drop-thought-verify'

// Migration coverage for v043: the thought-verifier subsystem is retired, so
// its table (created by v019 and kept as history there) leaves the live schema.

const MEM_OPTS = { isMemory: true, dimensions: 384 }

beforeEach(createTestDb)
afterEach(closeDb)

function tableNames(db: Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as {
    name: string
  }[]).map(row => row.name)
}

function indexNames(db: Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name`).all() as {
    name: string
  }[]).map(row => row.name)
}

/** The bootstrap tables `initDb` creates before the migration list runs (`init.ts`). */
function bootstrap(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS thoughts (
    id TEXT PRIMARY KEY, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', source TEXT,
    project_id TEXT, is_cluster INTEGER DEFAULT 0, is_profile INTEGER DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'related', created_at TEXT NOT NULL, UNIQUE(source_id, target_id, type)
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)`)
}

/** Build a full schema in a throwaway `:memory:` DB from a migration subset. */
function buildSchema(migrations: Migration[]): Database {
  const db = new Database(':memory:')
  bootstrap(db)
  for (const migration of migrations) migration.apply(db, MEM_OPTS)
  return db
}

test('v043: a fresh DB has neither the thought_verify table nor its indexes', () => {
  const db = getDb()
  expect(tableNames(db)).not.toContain('thought_verify')
  expect(indexNames(db)).not.toContain('idx_thought_verify_flagged')
  expect(indexNames(db)).not.toContain('idx_thought_verify_thought')
})

test('v043: apply() drops the table and both indexes, and a second run is a no-op', () => {
  const db = buildSchema(MIGRATIONS.filter(migration => migration.version <= 42))
  try {
    // Precondition: the v042 shape every existing install has.
    expect(tableNames(db)).toContain('thought_verify')
    expect(indexNames(db)).toContain('idx_thought_verify_flagged')

    v043.apply(db)
    expect(tableNames(db)).not.toContain('thought_verify')
    expect(indexNames(db)).not.toContain('idx_thought_verify_flagged')
    expect(indexNames(db)).not.toContain('idx_thought_verify_thought')

    expect(() => v043.apply(db)).not.toThrow()
  } finally {
    db.close()
  }
})

test('v043: a fresh DB and a v042 -> v043 migrated DB produce the same table set', () => {
  const fresh = buildSchema(MIGRATIONS.filter(migration => migration.version <= 43))
  const migrated = buildSchema(MIGRATIONS.filter(migration => migration.version <= 42))
  try {
    // The legacy install still carries the retired table before the upgrade.
    expect(tableNames(migrated)).toContain('thought_verify')

    v043.apply(migrated)
    v043.apply(migrated)

    expect(tableNames(migrated)).toEqual(tableNames(fresh))
  } finally {
    fresh.close()
    migrated.close()
  }
})

test('v043: registered as the head migration version', () => {
  expect(MIGRATIONS.at(-1)?.version).toBe(47)
})
