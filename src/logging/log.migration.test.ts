import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LogStore } from './log'

// Regression coverage for audit M2 / #1752: logs.db carries its own `_meta`
// schema_version and evolves through LOG_MIGRATIONS via `ensureSchema`, applied
// forward-only inside one transaction per migration. The pre-policy code only did
// `CREATE TABLE IF NOT EXISTS`, which is a silent no-op on an already-deployed
// logs.db; these tests pin the versioned path (stamp, upgrade of a legacy DB,
// skip-on-reopen, rollback on a failed stamp).

const tmpRoot = mkdtempSync(join(tmpdir(), 'synaptomind-log-migration-'))

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

function logDbPath(name: string): string {
  return join(tmpRoot, `${name}.db`)
}

function raw<T>(path: string, fn: (db: Database) => T): T {
  const db = new Database(path)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function schemaVersion(path: string): string | undefined {
  return raw(path, db => {
    const row = db.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined
    return row?.value
  })
}

function tableNames(path: string): string[] {
  return raw(path, db =>
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(r => r.name)
  )
}

// Fail the migration-1 stamp while leaving the DDL alone, so apply() runs for real
// and only the version write dies — the crash-between-DDL-and-stamp state.
function installStampFailureTrigger(path: string): void {
  raw(path, db => {
    db.exec(`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)`)
    db.exec(
      `CREATE TRIGGER fail_stamp_insert BEFORE INSERT ON _meta
         WHEN NEW.key = 'schema_version' AND NEW.value = '1'
         BEGIN SELECT RAISE(ABORT, 'simulated stamp failure'); END`
    )
    db.exec(
      `CREATE TRIGGER fail_stamp_update BEFORE UPDATE ON _meta
         WHEN NEW.key = 'schema_version' AND NEW.value = '1'
         BEGIN SELECT RAISE(ABORT, 'simulated stamp failure'); END`
    )
  })
}

function dropStampFailureTrigger(path: string): void {
  raw(path, db => {
    db.exec(`DROP TRIGGER IF EXISTS fail_stamp_insert`)
    db.exec(`DROP TRIGGER IF EXISTS fail_stamp_update`)
  })
}

test('a fresh logs.db stamps schema_version = 1 and creates both tables (#1752)', () => {
  const path = logDbPath('fresh')
  const store = new LogStore({ logDbPath: path })
  try {
    expect(store.getLogDb()).not.toBeNull()
  } finally {
    store.closeLogDb()
  }

  expect(schemaVersion(path)).toBe('1')
  expect(tableNames(path)).toContain('logs')
  expect(tableNames(path)).toContain('thought_telemetry')
})

test('a pre-policy logs.db without _meta migrates to v1 on open, rows preserved (#1752)', () => {
  const path = logDbPath('legacy')
  // The shape the old `CREATE TABLE IF NOT EXISTS` path left behind: data, no _meta.
  raw(path, db => {
    db.exec(`
      CREATE TABLE logs (
        id         TEXT PRIMARY KEY,
        level      TEXT NOT NULL,
        type       TEXT NOT NULL,
        message    TEXT NOT NULL,
        metadata   TEXT,
        source     TEXT,
        error      TEXT,
        created_at TEXT NOT NULL
      )
    `)
    db.prepare(
      `INSERT INTO logs (id, level, type, message, source, created_at)
       VALUES ('legacy-1', 'info', 'legacy', 'pre-policy row', 'synaptomind', '2026-10-19T00:00:00.000Z')`
    ).run()
  })
  expect(tableNames(path)).not.toContain('_meta')

  const store = new LogStore({ logDbPath: path })
  try {
    const db = store.getLogDb()
    expect(db).not.toBeNull()
    const row = db?.prepare(`SELECT message FROM logs WHERE id = 'legacy-1'`).get() as
      | { message: string }
      | undefined
    expect(row?.message).toBe('pre-policy row')
  } finally {
    store.closeLogDb()
  }

  expect(schemaVersion(path)).toBe('1')
  expect(tableNames(path)).toContain('thought_telemetry')
})

test('reopening a migrated logs.db does not re-run migrations (#1752)', () => {
  const path = logDbPath('reopen')
  const first = new LogStore({ logDbPath: path })
  try {
    expect(first.getLogDb()).not.toBeNull()
  } finally {
    first.closeLogDb()
  }
  expect(schemaVersion(path)).toBe('1')

  // With v1 already stamped, a second open must skip the runner entirely. If it
  // re-applied migration 1, this trigger would abort the stamp write and the open
  // would fail (ensureDb swallows the error and returns null).
  installStampFailureTrigger(path)

  const second = new LogStore({ logDbPath: path })
  try {
    expect(second.getLogDb()).not.toBeNull()
    expect(schemaVersion(path)).toBe('1')
  } finally {
    second.closeLogDb()
  }

  dropStampFailureTrigger(path)
})

test('a failed migration stamp rolls back both the DDL and the version (#1752)', () => {
  const path = logDbPath('rollback')
  installStampFailureTrigger(path)

  // Migration 1's DDL runs, the stamp fails mid-transaction; ensureDb swallows the
  // error, so the store reports no DB.
  const broken = new LogStore({ logDbPath: path })
  try {
    expect(broken.getLogDb()).toBeNull()
  } finally {
    broken.closeLogDb()
  }

  // Rolled back: neither table survived and nothing was stamped.
  expect(tableNames(path)).not.toContain('logs')
  expect(tableNames(path)).not.toContain('thought_telemetry')
  expect(schemaVersion(path)).toBeUndefined()

  // The next open replays migration 1 cleanly and stamps v1.
  dropStampFailureTrigger(path)
  const recovered = new LogStore({ logDbPath: path })
  try {
    expect(recovered.getLogDb()).not.toBeNull()
  } finally {
    recovered.closeLogDb()
  }

  expect(schemaVersion(path)).toBe('1')
  expect(tableNames(path)).toContain('logs')
  expect(tableNames(path)).toContain('thought_telemetry')
})
