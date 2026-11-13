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

function guardMessage(path: string): string {
  try {
    initDb({ dbPath: path, runMigrations: true })
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  throw new Error('expected the version guard to refuse')
}

test('boot refuses when schema_version exceeds max migration', () => {
  initDb({ dbPath, runMigrations: true })
  closeDb()
  const raw = new Database(dbPath)
  try {
    raw.loadExtension(vec0Path())
    raw.prepare(`UPDATE _meta SET value = '9999' WHERE key = 'schema_version'`).run()
  } finally {
    raw.close()
  }
  const message = guardMessage(dbPath)
  expect(message).toContain('newer than this binary')
  // The sibling message carries the same two steps: stop the unit, then restore the newest
  // deploy-side copy (which loses every later write) or upgrade the binary.
  expect(message).toContain('systemctl stop synaptomind')
  expect(message).toContain('up to five starts a minute, after which it stops retrying')
  expect(message).toContain('<db>.backup/')
  expect(message).toContain('<basename>.<timestamp>-<pid>-<n>.bak')
  expect(message).toContain('which loses every write made after it was taken')
  expect(message).toContain('or upgrade the binary')
  expect(message.indexOf('systemctl stop synaptomind')).toBeLessThan(
    message.indexOf('<db>.backup/')
  )
})

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
    return (
      raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
    ).map(r => r.name)
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

  expect(journalMode(path)).toBe('delete')
  expect(tableNames(path)).toEqual(['_meta'])
})

function openDescriptorsFor(path: string): string[] {
  const fdDir = '/proc/self/fd'
  const targets: string[] = []
  for (const entry of readdirSync(fdDir)) {
    try {
      const target = readlinkSync(join(fdDir, entry))
      if (target === path || target.startsWith(`${path}-`)) targets.push(target)
    } catch {}
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

  expect(openDescriptorsFor(path)).toEqual([])
})
