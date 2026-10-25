import { Database } from 'bun:sqlite'
import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
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
