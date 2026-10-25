import { afterAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb } from '../db/container'
import { closeDb, initDb } from './init'

describe('closeDb', () => {
  test('checkpoints so a reopened DB reads the inserted row and leaves no WAL residue', () => {
    const dir = mkdtempSync(join(tmpdir(), 'synaptomind-closedb-'))
    const dbPath = join(dir, 'test.db')
    try {
      initDb({ dbPath, runMigrations: true })
      const db = getDb()
      db.run('CREATE TABLE IF NOT EXISTS t(x)')
      db.run('INSERT INTO t VALUES (1)')
      closeDb()

      // Durability: the row must survive a reopen from disk, not just via unlink.
      const reopened = new Database(dbPath)
      const row = reopened.prepare('SELECT x FROM t').get() as { x: number }
      expect(row.x).toBe(1)
      reopened.close(true)

      expect(existsSync(dbPath)).toBe(true)
      expect(existsSync(`${dbPath}-wal`)).toBe(false)
      expect(existsSync(`${dbPath}-shm`)).toBe(false)
      expect(existsSync(`${dbPath}-journal`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('does not delete sidecars held by a live second connection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'synaptomind-closedb-'))
    const dbPath = join(dir, 'test.db')
    let second: Database | null = null
    let third: Database | null = null
    try {
      initDb({ dbPath, runMigrations: true })
      const db = getDb()
      db.run('CREATE TABLE IF NOT EXISTS t(x)')
      db.run('INSERT INTO t VALUES (1)')

      // A second live connection holds the WAL sidecars.
      second = new Database(dbPath)
      second.run('PRAGMA busy_timeout = 5000')

      // closeDb() must not unlink sidecars out from under the holder.
      expect(() => closeDb()).not.toThrow()

      // The holder must remain usable (no "disk I/O error").
      expect(() => second!.prepare('SELECT 1').get()).not.toThrow()

      // A fresh connection opened afterwards must also work (durability).
      third = new Database(dbPath)
      expect(() => third!.prepare('SELECT 1').get()).not.toThrow()
    } finally {
      try { third?.close() } catch { /* ignore */ }
      try { second?.close() } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('is safe to call when no db is initialized', () => {
    closeDb()
    expect(() => closeDb()).not.toThrow()
  })

  afterAll(() => {
    closeDb()
  })
})