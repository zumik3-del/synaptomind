import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupDatabase, pruneBackups } from './backup'
import { closeDb, initDb } from './init'

const tmpRoot = mkdtempSync(join(tmpdir(), 'synaptomind-backup-'))

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

test('backupDatabase writes a VACUUM INTO snapshot next to the db', () => {
  const dir = join(tmpRoot, 'snap')
  const { mkdirSync } = require('node:fs')
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'test.db')
  const db = new Database(dbPath)
  db.run('CREATE TABLE t (id INTEGER, v TEXT)')
  db.run("INSERT INTO t VALUES (1, 'hello')")

  const backupPath = backupDatabase(db, dbPath, 47, 5)
  expect(existsSync(backupPath)).toBe(true)
  expect(backupPath).toContain('.pre-v47.')
  expect(backupPath.endsWith('.bak')).toBe(true)

  // The snapshot is a usable database with the same data.
  const snap = new Database(backupPath, { readonly: true })
  const row = snap.prepare('SELECT v FROM t WHERE id = 1').get() as { v: string }
  expect(row.v).toBe('hello')
  snap.close()
  db.close()
})

test('backupDatabase fails loudly on an unwritable target', () => {
  const dir = join(tmpRoot, 'bad')
  const { mkdirSync } = require('node:fs')
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'test.db')
  const db = new Database(dbPath)
  db.run('CREATE TABLE t (id INTEGER)')
  expect(() => backupDatabase(db, join(dir, 'no-such-dir', 'test.db'), 1)).toThrow()
  db.close()
})

test('pruneBackups keeps only the N most recent backups', () => {
  const dir = join(tmpRoot, 'prune')
  const { mkdirSync } = require('node:fs')
  mkdirSync(dir, { recursive: true })
  const base = 'synaptomind.db'
  // Create 4 backups with distinct mtimes.
  for (let i = 0; i < 4; i++) {
    const p = join(dir, `${base}.pre-v${10 + i}.2026-01-0${i + 1}T00:00:00.000Z.bak`)
    writeFileSync(p, '')
    // Stagger mtimes.
    const { utimesSync } = require('node:fs')
    utimesSync(p, new Date(2026, 0, i + 1), new Date(2026, 0, i + 1))
  }
  pruneBackups(dir, base, 2)
  const { readdirSync } = require('node:fs')
  const remaining = readdirSync(dir).filter((n: string) => n.endsWith('.bak'))
  expect(remaining.length).toBe(2)
})

test('initDb takes a backup when migrations are pending', () => {
  const dir = join(tmpRoot, 'init')
  const { mkdirSync, readdirSync } = require('node:fs')
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'test.db')

  initDb({ dbPath, runMigrations: true })
  closeDb()

  // Rewind one version so the next boot has a pending migration.
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
  const { mkdirSync, readdirSync } = require('node:fs')
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