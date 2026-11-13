import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupDatabase, pruneBackups } from './backup'
import { closeDb, initDb } from './init'
import { MIGRATIONS } from './migrations'

const tmpRoot = mkdtempSync(join(tmpdir(), 'synaptomind-backup-'))

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

function failureMessage(run: () => unknown): string {
  let message: string | null = null
  try {
    run()
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  expect(message).not.toBeNull()
  return message as string
}

test('backupDatabase writes a VACUUM INTO snapshot next to the db', () => {
  const dir = join(tmpRoot, 'snap')
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'test.db')
  const db = new Database(dbPath)
  db.run('CREATE TABLE t (id INTEGER, v TEXT)')
  db.run("INSERT INTO t VALUES (1, 'hello')")

  const backupPath = backupDatabase(db, dbPath, 47, 5)
  expect(existsSync(backupPath)).toBe(true)
  expect(backupPath).toContain('.pre-v47.')
  expect(backupPath.endsWith('.bak')).toBe(true)

  const snap = new Database(backupPath, { readonly: true })
  const row = snap.prepare('SELECT v FROM t WHERE id = 1').get() as { v: string }
  expect(row.v).toBe('hello')
  snap.close()
  db.close()
})

test('backupDatabase fails loudly on an unwritable target', () => {
  const dir = join(tmpRoot, 'bad')
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'test.db')
  const db = new Database(dbPath)
  db.run('CREATE TABLE t (id INTEGER)')
  expect(() => backupDatabase(db, join(dir, 'no-such-dir', 'test.db'), 1)).toThrow()
  db.close()
})

test('pruneBackups keeps only the N most recent backups', () => {
  const dir = join(tmpRoot, 'prune')
  mkdirSync(dir, { recursive: true })
  const base = 'synaptomind.db'
  for (let i = 0; i < 4; i++) {
    const p = join(dir, `${base}.pre-v${10 + i}.2026-01-0${i + 1}T00:00:00.000Z.bak`)
    writeFileSync(p, '')
    const { utimesSync } = require('node:fs')
    utimesSync(p, new Date(2026, 0, i + 1), new Date(2026, 0, i + 1))
  }
  pruneBackups(dir, base, 2)
  const remaining = readdirSync(dir).filter((n: string) => n.endsWith('.bak'))
  expect(remaining.length).toBe(2)
})

test('initDb takes a backup when migrations are pending', () => {
  const dir = join(tmpRoot, 'init')
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'test.db')

  initDb({ dbPath, runMigrations: true })
  closeDb()

  const db = new Database(dbPath)
  db.prepare("UPDATE _meta SET value = '46' WHERE key = 'schema_version'").run()
  db.close()

  const before = readdirSync(dir).filter((n: string) => n.endsWith('.bak')).length
  initDb({ dbPath, runMigrations: true })
  const after = readdirSync(dir).filter((n: string) => n.endsWith('.bak')).length
  expect(after).toBeGreaterThan(before)
  closeDb()
})

test('initDb does not back up when no migrations are pending', () => {
  const dir = join(tmpRoot, 'nopending')
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'test.db')

  initDb({ dbPath, runMigrations: true })
  closeDb()

  const before = readdirSync(dir).filter((n: string) => n.endsWith('.bak')).length
  initDb({ dbPath, runMigrations: true })
  const after = readdirSync(dir).filter((n: string) => n.endsWith('.bak')).length
  expect(after).toBe(before)
  closeDb()
})

test('a failed migration snapshot names the target, not the version the file is at', () => {
  // A root process ignores the directory mode, so it cannot make the snapshot fail this way.
  if (process.getuid?.() === 0) return

  const dir = join(tmpRoot, 'failed-migration-snapshot')
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'test.db')
  initDb({ dbPath, runMigrations: true })
  closeDb()

  const newest = Math.max(...MIGRATIONS.map(m => m.version))
  const at = newest - 1
  // One migration pending: this boot takes a migration snapshot and is moving the schema to the
  // newest version while the file's own stamp says something older.
  const rewind = new Database(dbPath)
  rewind.prepare(`UPDATE _meta SET value = ? WHERE key = 'schema_version'`).run(String(at))
  rewind.close()
  // The setup boot took its own migration snapshot; only this test's failed attempt may add one.
  for (const stale of readdirSync(dir).filter(name => name.endsWith('.bak'))) {
    rmSync(join(dir, stale))
  }

  // A live connection keeps the WAL sidecars on disk, so the boot below reaches the snapshot;
  // without them `PRAGMA journal_mode = WAL` fails on the read-only directory first and the
  // pending migration is never attempted.
  const keeper = new Database(dbPath)
  keeper.prepare(`SELECT COUNT(*) AS cnt FROM thoughts`).get()
  chmodSync(dir, 0o555)
  let message: string | null = null
  try {
    message = failureMessage(() => initDb({ dbPath, runMigrations: true }))
  } finally {
    chmodSync(dir, 0o755)
    keeper.close(true)
  }

  // The version in the failure is the target the boot was moving to, never the schema the file is
  // at: a message that says "schema v<N>" here is read as the current version.
  expect(message).toContain(
    `Database backup failed before applying migrations (this boot was moving the schema to v${newest})`
  )
  expect(message).not.toContain('the schema is at')
  expect(message).not.toContain(`(schema v${newest})`)

  // The failed snapshot aborted the boot before the pending migration ran, and left no file behind.
  const after = new Database(dbPath)
  try {
    const row = after.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get() as {
      value: string
    }
    expect(row.value).toBe(String(at))
  } finally {
    after.close()
  }
  expect(readdirSync(dir).filter(name => name.endsWith('.bak'))).toEqual([])
})
