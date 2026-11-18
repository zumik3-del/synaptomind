import { Database } from 'bun:sqlite'
import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, setDb } from '../context/container'
import { vec0Path } from '../runtime-mode'
import { closeDb, initDb, openDatabase } from './init'

const tmpRoot = mkdtempSync(join(tmpdir(), 'synaptomind-init-'))
let cases = 0

afterEach(() => {
  closeDb()
})

afterAll(() => {
  closeDb()
  rmSync(tmpRoot, { recursive: true, force: true })
})

function freshDbPath(): string {
  cases += 1
  return join(tmpRoot, `case-${cases}.db`)
}

function openRaw<T>(dbPath: string, fn: (db: Database) => T): T {
  const db = new Database(dbPath)
  try {
    db.loadExtension(vec0Path())
    return fn(db)
  } finally {
    db.close(true)
  }
}

function projectRow(dbPath: string, id: string): { id: string; name: string } | undefined {
  return openRaw(dbPath, db => {
    return db.prepare(`SELECT id, name FROM projects WHERE id = ?`).get(id) as
      | { id: string; name: string }
      | undefined
  })
}

function defaultProjectId(dbPath: string): string | undefined {
  return openRaw(dbPath, db => {
    const row = db.prepare(`SELECT value FROM _meta WHERE key = 'default_project_id'`).get() as
      | { value: string }
      | undefined
    return row?.value
  })
}

test('a boot whose default project row vanished recreates it instead of failing', () => {
  const dbPath = freshDbPath()
  initDb({ dbPath, runMigrations: true })
  const defaultId = defaultProjectId(dbPath) as string
  closeDb()
  openRaw(dbPath, db => db.prepare(`DELETE FROM projects WHERE id = ?`).run(defaultId))
  expect(projectRow(dbPath, defaultId)).toBeNull()

  const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  try {
    initDb({ dbPath, runMigrations: true })
    expect(errorSpy).toHaveBeenCalledWith(`[db] Default project ${defaultId} missing — recreating`)
  } finally {
    errorSpy.mockRestore()
  }

  expect(projectRow(dbPath, defaultId)).toEqual({ id: defaultId, name: 'Default' })
  expect(defaultProjectId(dbPath)).toBe(defaultId)
})

test('a boot that finds no default project stamp creates the project and the stamp', () => {
  const dbPath = freshDbPath()
  initDb({ dbPath, runMigrations: true })
  const originalId = defaultProjectId(dbPath) as string
  closeDb()
  openRaw(dbPath, db => {
    db.prepare(`DELETE FROM _meta WHERE key = 'default_project_id'`).run()
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(originalId)
  })

  initDb({ dbPath, runMigrations: true })

  const createdId = defaultProjectId(dbPath)
  expect(createdId).toBeString()
  expect(createdId).not.toBe(originalId)
  expect(projectRow(dbPath, createdId as string)).toEqual({
    id: createdId as string,
    name: 'Default'
  })
})

test('a missing vec0 extension is reported against the path the boot tried', () => {
  const dbPath = freshDbPath()
  const bogus = join(tmpRoot, 'no-such-vec0.so')
  const previous = process.env.SYNAPTOMIND_VEC0_PATH
  process.env.SYNAPTOMIND_VEC0_PATH = bogus
  try {
    expect(() => openDatabase(dbPath)).toThrow(`vec0 extension failed to load from ${bogus}`)
  } finally {
    if (previous === undefined) delete process.env.SYNAPTOMIND_VEC0_PATH
    else process.env.SYNAPTOMIND_VEC0_PATH = previous
  }

  // The failed boot closed its handle and never registered a database.
  expect(() => getDb()).toThrow('DB not initialized')
})

test('the memory path skips the extension load, so it opens without vec0', () => {
  const db = openDatabase(':memory:')
  try {
    expect(db.prepare(`SELECT 1 AS ok`).get()).toEqual({ ok: 1 })
  } finally {
    db.close(true)
  }
})

test('closeDb logs a checkpoint refusal and still drops the handle', () => {
  const closed = new Database(':memory:')
  closed.close(true)
  setDb(closed)

  const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  try {
    closeDb()
    expect(errorSpy).toHaveBeenCalledWith(
      '[db] wal_checkpoint(TRUNCATE) failed:',
      expect.anything()
    )
  } finally {
    errorSpy.mockRestore()
  }

  expect(() => getDb()).toThrow('DB not initialized')
})

test('closeDb on a boot with no database is a no-op', () => {
  expect(() => closeDb()).not.toThrow()
  expect(() => getDb()).toThrow('DB not initialized')
})
