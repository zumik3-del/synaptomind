import { Database } from 'bun:sqlite'
import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vec0Path } from '../runtime-mode'
import { closeDb, initDb } from './init'

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
  return openRaw(db =>
    (db.prepare(`PRAGMA table_info(thoughts)`).all() as { name: string }[]).map(c => c.name)
  )
}

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

function rewindToV35(): void {
  openRaw(db => {
    // v048's move trigger names `NEW.is_global`, so it has to go before the
    // column drop (SQLite refuses a DROP COLUMN that a trigger references).
    db.exec(`DROP TRIGGER IF EXISTS trg_thoughts_vec_scope`)
    db.exec(`DROP TABLE IF EXISTS vec_scope_move`)
    db.exec(`DROP INDEX IF EXISTS idx_thoughts_is_global`)
    db.exec(`DELETE FROM _meta WHERE key = 'vec_scope_v048'`)
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
  initDb({ dbPath, runMigrations: true })
  expect(schemaVersion()).toBe('48')
  closeDb()
  rewindToV35()
  installStampFailureTrigger()
  expect(schemaVersion()).toBe('35')
  expect(thoughtColumns()).not.toContain('archived_at')

  expect(() => initDb({ dbPath, runMigrations: true })).toThrow('simulated stamp failure')

  expect(schemaVersion()).toBe('35')
  expect(thoughtColumns()).not.toContain('archived_at')

  dropStampFailureTrigger()
  initDb({ dbPath, runMigrations: true })
  expect(schemaVersion()).toBe('48')
  const cols = thoughtColumns()
  expect(cols).toContain('archived_at')
  expect(cols).toContain('is_protected')
  expect(cols).toContain('surface_after')
  expect(cols).toContain('is_global')
})
