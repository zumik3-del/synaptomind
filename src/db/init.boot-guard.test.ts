import { Database } from 'bun:sqlite'
import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vec0Path } from '../runtime-mode'
import { closeDb, initDb } from './init'

const tmpRoot = mkdtempSync(join(tmpdir(), 'synaptomind-boot-guard-'))
const dbPath = join(tmpRoot, 'test.db')

afterEach(() => {
  closeDb()
})

afterAll(() => {
  closeDb()
  rmSync(tmpRoot, { recursive: true, force: true })
})

test('boot refuses when schema_version exceeds max migration', () => {
  initDb({ dbPath, runMigrations: true })
  closeDb()
  // Bump schema_version beyond any migration.
  const raw = new Database(dbPath)
  try {
    raw.loadExtension(vec0Path())
    raw.prepare(`UPDATE _meta SET value = '9999' WHERE key = 'schema_version'`).run()
  } finally {
    raw.close()
  }
  expect(() => initDb({ dbPath, runMigrations: true })).toThrow('newer than this binary')
})

/**
 * A file that only holds `_meta` with a future schema_version — the shape an
 * older binary meets after a newer one ran. Nothing else exists yet, so any
 * side effect the refused boot leaves behind is visible.
 */
function writeFutureOnlyDatabase(path: string): void {
  const raw = new Database(path)
  try {
    raw.run(`CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT)`)
    raw.prepare(`INSERT INTO _meta (key, value) VALUES ('schema_version', '9999')`).run()
  } finally {
    // `close(true)`, not `close()`: bun:sqlite keeps the file descriptor of a
    // connection that still has a prepared statement when it closes leniently,
    // which would read as a leak in the descriptor test below.
    raw.close(true)
  }
}

function tableNames(path: string): string[] {
  const raw = new Database(path)
  try {
    return (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(r => r.name)
  } finally {
    raw.close(true)
  }
}

function journalMode(path: string): string {
  const raw = new Database(path)
  try {
    return (raw.prepare(`PRAGMA journal_mode`).get() as { journal_mode: string }).journal_mode
  } finally {
    raw.close(true)
  }
}

test('the version guard runs before bootstrap DDL and before the WAL switch', () => {
  const path = join(tmpRoot, 'future-only.db')
  writeFutureOnlyDatabase(path)

  expect(() => initDb({ dbPath: path, runMigrations: true })).toThrow('newer than this binary')

  // PRAGMA journal_mode is persisted in the file header, so 'delete' proves the
  // WAL switch was never reached on the refused boot.
  expect(journalMode(path)).toBe('delete')
  // And no bootstrap table was created on the way to the guard.
  expect(tableNames(path)).toEqual(['_meta'])
})

/** Every fd of this process whose target is `path` or one of its sidecars. */
function openDescriptorsFor(path: string): string[] {
  const fdDir = '/proc/self/fd'
  const targets: string[] = []
  for (const entry of readdirSync(fdDir)) {
    try {
      const target = readlinkSync(join(fdDir, entry))
      if (target === path || target.startsWith(`${path}-`)) targets.push(target)
    } catch {
      // The fd was closed between readdir and readlink — never the one we look for.
    }
  }
  return targets
}

test('the refused boot closes its connection instead of leaking the handle', () => {
  // /proc/self/fd is the only way to observe a leaked handle: SQLite holds no
  // lock while idle, so a second connection opens fine either way.
  if (process.platform !== 'linux') return

  const path = join(tmpRoot, 'leak-guard.db')
  writeFutureOnlyDatabase(path)
  expect(openDescriptorsFor(path)).toEqual([])

  expect(() => initDb({ dbPath: path, runMigrations: true })).toThrow('newer than this binary')

  // The handle was never published through `setDb`, so `closeDb()` cannot reach
  // it: if init does not close it itself, the descriptor stays open.
  expect(openDescriptorsFor(path)).toEqual([])
})
