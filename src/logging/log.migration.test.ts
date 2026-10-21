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

// The deployed production logs.db: migration 1 already ran on it, so it is
// stamped schema_version = 1 and carries BOTH tables with their rows (the
// deployed file held ~6 200 logs rows and ~36 000 thought_telemetry rows).
// The DDL below is migration 1's own DDL, verbatim.
function seedV1LogsDb(path: string): void {
  raw(path, db => {
    db.exec(`CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT)`)
    db.prepare(`INSERT INTO _meta (key, value) VALUES ('schema_version', '1')`).run()
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
    db.exec(`
      CREATE TABLE thought_telemetry (
        id            TEXT PRIMARY KEY,
        correlation_id TEXT,
        user_id       TEXT,
        action        TEXT NOT NULL,
        tool_name     TEXT NOT NULL,
        prev_tool     TEXT,
        query         TEXT,
        thought_id    TEXT,
        response_size INTEGER,
        latency_ms    INTEGER,
        session_id    TEXT,
        meta          TEXT,
        created_at    TEXT NOT NULL
      )
    `)
    db.prepare(
      `INSERT INTO logs (id, level, type, message, metadata, source, created_at)
       VALUES ('v1-log-1', 'info', 'embedding', 'deployed row', NULL, 'synaptomind', '2026-10-19T00:00:00.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO thought_telemetry (id, action, tool_name, created_at)
       VALUES ('v1-telemetry-1', 'query', 'memory_telemetry', '2026-10-19T00:00:00.000Z')`
    ).run()
  })
}

test('a fresh logs.db stamps schema_version = 2 and creates only the logs table (#1752)', () => {
  const path = logDbPath('fresh')
  const store = new LogStore({ logDbPath: path })
  try {
    expect(store.getLogDb()).not.toBeNull()
  } finally {
    store.closeLogDb()
  }

  expect(schemaVersion(path)).toBe('2')
  expect(tableNames(path)).toContain('logs')
  expect(tableNames(path)).not.toContain('thought_telemetry')
})

test('a pre-policy logs.db without _meta migrates on open, rows preserved (#1752)', () => {
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

  expect(schemaVersion(path)).toBe('2')
  expect(tableNames(path)).not.toContain('thought_telemetry')
})

test('reopening a migrated logs.db does not re-run migrations (#1752)', () => {
  const path = logDbPath('reopen')
  const first = new LogStore({ logDbPath: path })
  try {
    expect(first.getLogDb()).not.toBeNull()
  } finally {
    first.closeLogDb()
  }
  expect(schemaVersion(path)).toBe('2')

  // With the current version already stamped, a second open must skip the runner
  // entirely. If it re-applied migration 1, this trigger would abort the stamp
  // write and the open would fail (ensureDb swallows the error and returns null).
  installStampFailureTrigger(path)

  const second = new LogStore({ logDbPath: path })
  try {
    expect(second.getLogDb()).not.toBeNull()
    expect(schemaVersion(path)).toBe('2')
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

  // The next open replays the migrations cleanly and stamps the current version.
  dropStampFailureTrigger(path)
  const recovered = new LogStore({ logDbPath: path })
  try {
    expect(recovered.getLogDb()).not.toBeNull()
  } finally {
    recovered.closeLogDb()
  }

  expect(schemaVersion(path)).toBe('2')
  expect(tableNames(path)).toContain('logs')
  expect(tableNames(path)).not.toContain('thought_telemetry')
})

// Regression coverage for #1770: a failed migration must not leave a poisoned
// connection on the store. ensureDb() opens the Database before ensureSchema()
// can throw, so without the explicit close+null in the catch block a second
// getLogDb() returned that half-initialized handle (non-null, no tables) instead
// of retrying. The fault is raised by stamping migration 1 while abort triggers
// stay installed, and cleared only to prove the retry can recover.
test('a failed migration does not poison the store: a later getLogDb() retries and returns null (#1770)', () => {
  const path = logDbPath('retry-after-failure')
  installStampFailureTrigger(path)

  const store = new LogStore({ logDbPath: path })
  try {
    // First open fails and reports no DB...
    expect(store.getLogDb()).toBeNull()
    // ...and the second open must fail the same way, not hand back the broken handle.
    expect(store.getLogDb()).toBeNull()

    // With the fault removed the same store can still recover on a third call.
    dropStampFailureTrigger(path)
    const recovered = store.getLogDb()
    expect(recovered).not.toBeNull()
    expect(schemaVersion(path)).toBe('2')
  } finally {
    store.closeLogDb()
  }

  expect(tableNames(path)).toContain('logs')
  expect(tableNames(path)).not.toContain('thought_telemetry')
})

// ADR 2026-10-21 (Q5) mandates the v1 -> v2 upgrade to be proven: "a test that
// opens a v1 logs.db, migrates it and asserts that `logs` survives and
// `thought_telemetry` is gone". The two cases above both start at version 0 (a
// fresh file, and a pre-policy file without `_meta`), so neither of them
// exercises the deployed path - a production logs.db that migration 1 already
// stamped. This case starts from exactly that shape.
test('a deployed v1 logs.db upgrades to v2: the telemetry table is gone, the logs rows survive (#1912, ADR Q5)', () => {
  const path = logDbPath('v1-upgrade')
  seedV1LogsDb(path)

  // The starting point is the deployed shape, not a fresh file.
  expect(schemaVersion(path)).toBe('1')
  expect(tableNames(path)).toContain('thought_telemetry')

  const store = new LogStore({ logDbPath: path })
  try {
    expect(store.getLogDb()).not.toBeNull()
  } finally {
    store.closeLogDb()
  }

  // Forward upgrade: the version becomes 2 and the telemetry table is dropped.
  expect(schemaVersion(path)).toBe('2')
  expect(tableNames(path)).not.toContain('thought_telemetry')
  expect(tableNames(path)).toContain('logs')

  // The telemetry rows went with the table - the data is dropped, not archived.
  expect(() => raw(path, db => db.prepare(`SELECT COUNT(*) FROM thought_telemetry`).get())).toThrow(
    /no such table: thought_telemetry/
  )

  // The logs rows survive: the audit trail is not derived data, it is why the
  // table is not dropped together with the telemetry one.
  const rows = raw(
    path,
    db =>
      db.prepare(`SELECT id, message, created_at FROM logs ORDER BY created_at`).all() as {
        id: string
        message: string
        created_at: string
      }[]
  )
  expect(rows).toHaveLength(1)
  expect(rows[0].id).toBe('v1-log-1')
  expect(rows[0].message).toBe('deployed row')
  expect(rows[0].created_at).toBe('2026-10-19T00:00:00.000Z')

  // The upgrade is forward-only and terminal: the next open must not replay
  // migration 1 and re-create the telemetry table.
  const reopened = new LogStore({ logDbPath: path })
  try {
    expect(reopened.getLogDb()).not.toBeNull()
  } finally {
    reopened.closeLogDb()
  }
  expect(schemaVersion(path)).toBe('2')
  expect(tableNames(path)).not.toContain('thought_telemetry')
})
