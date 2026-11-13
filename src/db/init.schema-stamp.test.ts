import { Database } from 'bun:sqlite'
import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { config } from '../config'
import { getDb } from '../context/container'
import { vec0Path } from '../runtime-mode'
import { drainPendingEmbeddings, seedThought } from '../test/helpers'
import { closeDb, initDb } from './init'
import { MIGRATIONS } from './migrations'

const NEWEST = Math.max(...MIGRATIONS.map(m => m.version))
const tmpRoot = mkdtempSync(join(tmpdir(), 'synaptomind-schema-stamp-'))
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

interface FileState {
  schema: { type: string; name: string; tbl_name: string; sql: string | null }[]
  vectors: { id: string }[]
  thoughts: { id: string; status: string }[]
  meta: { key: string; value: string | null }[]
}

function fileState(dbPath: string): FileState {
  return openRaw(dbPath, db => {
    const vec = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'vec_thoughts'`).get()
    return {
      schema: db
        .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`)
        .all() as FileState['schema'],
      vectors: (vec === null
        ? []
        : db.prepare(`SELECT id FROM vec_thoughts ORDER BY id`).all()) as FileState['vectors'],
      thoughts: db
        .prepare(`SELECT id, status FROM thoughts ORDER BY id`)
        .all() as FileState['thoughts'],
      meta: db.prepare(`SELECT key, value FROM _meta ORDER BY key`).all() as FileState['meta']
    }
  })
}

function stamp(dbPath: string): string | null {
  return openRaw(dbPath, db => {
    const row = db.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined
    return row?.value ?? null
  })
}

function vecDdl(dbPath: string): string {
  return openRaw(
    dbPath,
    db =>
      (
        db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'vec_thoughts'`).get() as {
          sql: string
        }
      ).sql
  )
}

function backupsOf(dbPath: string): string[] {
  const prefix = `${basename(dbPath)}.pre-v`
  return readdirSync(dirname(dbPath)).filter(name => name.startsWith(prefix))
}

function refusalMessage(run: () => unknown): string {
  let message: string | null = null
  try {
    run()
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  expect(message).not.toBeNull()
  return message as string
}

function seedMigratedDb(dbPath: string): string {
  initDb({ dbPath, runMigrations: true })
  const id = seedThought({ content: 'keep my vector' })
  const embedding = new Float32Array(config.embedder.dimensions)
  getDb()
    .prepare(`INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, 'default')`)
    .run(
      id,
      Buffer.from(embedding.buffer as ArrayBuffer, embedding.byteOffset, embedding.byteLength)
    )
  drainPendingEmbeddings([id])
  closeDb()
  return id
}

function dropStamp(dbPath: string): void {
  openRaw(dbPath, db => db.prepare(`DELETE FROM _meta WHERE key = 'schema_version'`).run())
}

test('a migrated database whose schema stamp is gone is refused with its schema untouched', () => {
  const dbPath = freshDbPath()
  const thoughtId = seedMigratedDb(dbPath)
  dropStamp(dbPath)
  const before = fileState(dbPath)
  const backupsBefore = backupsOf(dbPath)

  const message = refusalMessage(() => initDb({ dbPath, runMigrations: true }))

  expect(message).toContain(`Refusing to open ${dbPath}: _meta.schema_version is missing`)
  expect(message).toContain('pending_embeddings')
  expect(message).toContain('restore the pre-upgrade backup')

  const after = fileState(dbPath)
  expect(after).toEqual(before)
  expect(after.vectors).toEqual([{ id: thoughtId }])
  expect(after.meta.map(row => row.key)).not.toContain('schema_version')
  expect(backupsOf(dbPath)).toEqual(backupsBefore)
})

test('the refusal says where the recovery number really comes from', () => {
  const dbPath = freshDbPath()
  seedMigratedDb(dbPath)
  dropStamp(dbPath)

  const message = refusalMessage(() => initDb({ dbPath, runMigrations: true }))

  // The number lives in the restored file's own stamp row...
  expect(message).toContain('read the number from its own _meta.schema_version row')
  // ...never in the backup filename, whose <N> means the version the boot was moving to.
  expect(message).toContain('Never copy the <N> out of a backup filename')
  expect(message).toContain('it names the version the upgrading boot was moving to')
  // The rebuild label is explained, so the operator does not restore a vector snapshot.
  expect(message).toContain('<db>.pre-v<N>.rebuild.<timestamp>.bak is a vector-index snapshot')
  // The fallback with no backup at all still points at the migration sources.
  expect(message).toContain('take the number from the migration sources (src/db/migrations)')
  // The phrase the removed-stamp test pins, kept verbatim.
  expect(message).toContain('restore the pre-upgrade backup')
  // The old advice to hand-write the newest applied migration number is gone.
  expect(message).not.toContain('write the newest applied migration number')
})

test('a stamp that is not a migration number is refused instead of read as version 0', () => {
  const template = freshDbPath()
  seedMigratedDb(template)

  for (const value of ['abc', '', '   ', '48abc', '4.8', '-1', null]) {
    const dbPath = freshDbPath()
    copyFileSync(template, dbPath)
    openRaw(dbPath, db =>
      db.prepare(`UPDATE _meta SET value = ? WHERE key = 'schema_version'`).run(value)
    )
    const before = fileState(dbPath)

    const message = refusalMessage(() => initDb({ dbPath, runMigrations: true }))

    expect(message).toContain('does not hold a migration number')
    expect(message).toContain(JSON.stringify(value))
    expect(fileState(dbPath)).toEqual(before)
    expect(backupsOf(dbPath)).toEqual([])
  }
})

test('a pre-baseline database still upgrades to the current version', () => {
  const dbPath = freshDbPath()
  // `runMigrations: false` runs the baseline DDL `init.ts` owns and stops, which is exactly
  // the file this guard has to keep upgrading: baseline tables, no stamp, no vec_thoughts.
  initDb({ dbPath, runMigrations: false })
  closeDb()
  const before = fileState(dbPath)
  expect(before.meta).toEqual([])
  const names = before.schema.map(object => object.name)
  const postBaseline = [
    'pending_embeddings',
    'placement_proposals',
    'tags',
    'thought_tags',
    'vec_thoughts'
  ]
  expect(names.filter(name => postBaseline.includes(name))).toEqual([])

  initDb({ dbPath, runMigrations: true })

  expect(stamp(dbPath)).toBe(String(NEWEST))
  expect(backupsOf(dbPath)).not.toEqual([])
  expect(fileState(dbPath).schema).toContainEqual(
    expect.objectContaining({ name: 'pending_embeddings' })
  )
  expect(vecDdl(dbPath)).toContain(`FLOAT[${config.embedder.dimensions}]`)
})

test('a baseline schema carrying only an added baseline column is refused too', () => {
  // The fingerprint has to look at columns as well as object names: a database that gained
  // nothing but `thoughts.archived_at` (v036) has no post-baseline *table* to spot.
  const dbPath = freshDbPath()
  initDb({ dbPath, runMigrations: false })
  closeDb()
  openRaw(dbPath, db => db.exec(`ALTER TABLE thoughts ADD COLUMN archived_at TEXT`))

  const message = refusalMessage(() => initDb({ dbPath, runMigrations: true }))

  expect(message).toContain('_meta.schema_version is missing')
  expect(message).toContain('thoughts.archived_at')
})

test('a database at the current version opens without refusing, warning or replaying', () => {
  const dbPath = freshDbPath()
  const thoughtId = seedMigratedDb(dbPath)
  const before = fileState(dbPath)
  const backupsBefore = backupsOf(dbPath)
  const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    initDb({ dbPath, runMigrations: true })
    expect(
      getDb().prepare(`SELECT content FROM thoughts WHERE id = ?`).get(thoughtId)
    ).not.toBeNull()
  } finally {
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  }

  expect(errorSpy).not.toHaveBeenCalled()
  expect(warnSpy).not.toHaveBeenCalled()
  expect(backupsOf(dbPath)).toEqual(backupsBefore)
  expect(fileState(dbPath)).toEqual(before)
})
