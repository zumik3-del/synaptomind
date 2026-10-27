import { Database } from 'bun:sqlite'
import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vec0Path } from '../runtime-mode'
import { closeDb, initDb } from './init'

// Regression coverage for audit H1 / #1751: a crash between migration.apply and
// the schema_version stamp must roll the whole migration back. Without the
// transaction, v036's non-idempotent `ALTER TABLE thoughts ADD COLUMN archived_at`
// commits first, the stamp fails, and the next boot dies with
// "duplicate column name: archived_at".
//
// The crash is injected where a process death would land: the body of the
// migration has run, the stamp has not. A `_meta` trigger makes the
// `schema_version = 36` write fail, so apply() runs for real and only the stamp
// is lost — the exact H1 state.

const tmpRoot = mkdtempSync(join(tmpdir(), 'synaptomind-migration-atomicity-'))
const dbPath = join(tmpRoot, 'test.db')

afterEach(() => {
  closeDb()
})

afterAll(() => {
  closeDb()
  rmSync(tmpRoot, { recursive: true, force: true })
})

function openRaw<T>(fn: (db: Database) => T): T {
  const db = new Database(dbPath)
  try {
    // thoughts has vec_thoughts triggers; writing to it needs the extension loaded.
    db.loadExtension(vec0Path())
    return fn(db)
  } finally {
    db.close()
  }
}

function schemaVersion(): string | undefined {
  return openRaw(db => {
    const row = db.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined
    return row?.value
  })
}

function thoughtColumns(): string[] {
  return openRaw(db => (db.prepare(`PRAGMA table_info(thoughts)`).all() as { name: string }[]).map(c => c.name))
}

// Fails any `schema_version = 36` stamp (the H1 write) while leaving 35 and 37+ alone.
function installStampFailureTrigger(): void {
  openRaw(db => {
    db.exec(
      `CREATE TRIGGER fail_stamp_insert BEFORE INSERT ON _meta
         WHEN NEW.key = 'schema_version' AND NEW.value = '36'
         BEGIN SELECT RAISE(ABORT, 'simulated stamp failure'); END`
    )
    db.exec(
      `CREATE TRIGGER fail_stamp_update BEFORE UPDATE ON _meta
         WHEN NEW.key = 'schema_version' AND NEW.value = '36'
         BEGIN SELECT RAISE(ABORT, 'simulated stamp failure'); END`
    )
  })
}

function dropStampFailureTrigger(): void {
  openRaw(db => {
    db.exec(`DROP TRIGGER IF EXISTS fail_stamp_insert`)
    db.exec(`DROP TRIGGER IF EXISTS fail_stamp_update`)
  })
}

/**
 * Rewind a fully migrated DB to the v035 shape by dropping everything v036..v042
 * introduced, so replaying those migrations is the real v35 -> v42 upgrade path.
 * `schema_version` stays 35 — exactly what a crash at v036 must recover from.
 */
function rewindToV35(): void {
  openRaw(db => {
    db.exec(`DROP INDEX IF EXISTS idx_thoughts_status_surface_after`)
    db.exec(`DROP INDEX IF EXISTS idx_thoughts_status_protected_created`)
    db.exec(`DROP INDEX IF EXISTS idx_thoughts_status_protected_archived`)
    db.exec(`DROP INDEX IF EXISTS idx_thought_importance_importance_hit`)
    db.exec(`ALTER TABLE thoughts DROP COLUMN archived_at`)
    db.exec(`ALTER TABLE thoughts DROP COLUMN is_protected`)
    db.exec(`ALTER TABLE thoughts DROP COLUMN surface_after`)
    db.exec(`ALTER TABLE thoughts DROP COLUMN is_global`)
    db.exec(`DROP TABLE IF EXISTS placement_proposals`)
    db.prepare(
      `INSERT INTO _meta (key, value) VALUES ('schema_version', '35')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run()
  })
}

test('a crash after v036 apply but before its stamp rolls back; the next boot replays cleanly (#1751)', () => {
  // Build a real schema, then rewind it to v035.
  initDb({ dbPath, runMigrations: true })
  expect(schemaVersion()).toBe('47')
  closeDb()
  rewindToV35()
  installStampFailureTrigger()
  expect(schemaVersion()).toBe('35')
  expect(thoughtColumns()).not.toContain('archived_at')

  // v036's non-idempotent ALTER runs; the stamp then fails mid-migration.
  expect(() => initDb({ dbPath, runMigrations: true })).toThrow('simulated stamp failure')

  // Rolled back: the half-applied ALTER did not survive and the version stayed 35.
  expect(schemaVersion()).toBe('35')
  expect(thoughtColumns()).not.toContain('archived_at')

  // The next boot replays v035 -> v042: without the rollback this is where
  // v036 would throw "duplicate column name: archived_at" and block startup.
  dropStampFailureTrigger()
  initDb({ dbPath, runMigrations: true })
  expect(schemaVersion()).toBe('47')
  const cols = thoughtColumns()
  expect(cols).toContain('archived_at')
  expect(cols).toContain('is_protected')
  expect(cols).toContain('surface_after')
  expect(cols).toContain('is_global')
})
