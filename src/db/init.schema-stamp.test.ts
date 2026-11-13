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

function sentencesOf(message: string): string[] {
  return message.split(/(?<=\.)\s+/)
}

function sentencesMentioning(message: string, ...needles: string[]): string[] {
  return sentencesOf(message).filter(sentence => needles.every(needle => sentence.includes(needle)))
}

function adviceOf(message: string): string {
  const start = message.indexOf('Recovery:')
  expect(start).toBeGreaterThan(-1)
  return message.slice(start)
}

// Baseline tables only plus `count` migration-like tables: no stamp row and no vec_thoughts, so
// every one of those tables is post-baseline evidence for the refusal.
function preBaselineWithTables(count: number): string {
  const dbPath = freshDbPath()
  initDb({ dbPath, runMigrations: false })
  closeDb()
  openRaw(dbPath, db => {
    for (let i = 1; i <= count; i++) {
      db.run(`CREATE TABLE extra_${String(i).padStart(2, '0')} (id INTEGER)`)
    }
  })
  return dbPath
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
  // ...never in the backup filename, whose <N> means the version the upgrading boot was moving to.
  expect(message).toContain('Never copy the <N> out of a backup filename')
  expect(message).toContain('it names the version the upgrading boot was moving to')
  // That warning is scoped to the migration kind: a .rebuild. name carries the version the file is
  // already at, so the blanket form ("it names the version the boot was moving to") is false there.
  const filename = sentencesMentioning(message, 'Never copy the <N> out of a backup filename')
  expect(filename).toHaveLength(1)
  expect(filename[0]).toContain('in a migration snapshot')
  // The rebuild label is explained as the snapshot of a database already at that version, so the
  // operator does not read a vector snapshot as a migration one.
  const rebuild = sentencesMentioning(message, '<db>.pre-v<N>.rebuild.<timestamp>.bak')
  expect(rebuild).toHaveLength(1)
  expect(rebuild[0]).toContain('vector-index snapshot taken at the current version')
  expect(rebuild[0]).toContain('not a migration one')
  // Restoring is one step and it prescribes no hand-write: the restored file carries its own stamp.
  const restore = sentencesMentioning(message, 'restore the pre-upgrade backup')
  expect(restore).toHaveLength(1)
  expect(restore[0]).toContain('write nothing by hand')
  // Hand-writing is a separate step with its own precondition: a copy of this file that still
  // carries its stamp row. It is not the "no backup at all" branch, and it is the only hand-write.
  expect(message).not.toContain('If no backup exists')
  const handWrites = sentencesOf(message).filter(
    sentence => sentence.includes('by hand') && !sentence.includes('restore the pre-upgrade backup')
  )
  expect(handWrites).toHaveLength(1)
  expect(handWrites[0]).toContain('a copy of this file')
  expect(handWrites[0]).toContain('still carries its stamp row')
  // No advice derives the number: every mention of a derivation source is a prohibition, and the
  // evidence list is demoted to a bound on how far the chain reached.
  const derivations = sentencesOf(message).filter(
    sentence => sentence.includes('migration sources') || sentence.includes('elements above')
  )
  expect(derivations.length).toBeGreaterThan(0)
  for (const sentence of derivations) expect(sentence).toContain('Never')
  expect(message).toContain('only bound how far the chain reached')
  expect(message).not.toContain('highest version whose objects all appear')
  // The phrase the removed-stamp test pins, kept verbatim.
  expect(message).toContain('restore the pre-upgrade backup')
})

test('the recovery advice names the deploy backups and puts the stop before the copy', () => {
  const dbPath = freshDbPath()
  seedMigratedDb(dbPath)
  dropStamp(dbPath)

  const message = refusalMessage(() => initDb({ dbPath, runMigrations: true }))
  const sentences = sentencesOf(message)

  // Both copy kinds are named, and the deploy-side one is the freshest of the pair: the update
  // path writes it into a directory the operator can list, and every later write is lost with it.
  const copies = sentencesMentioning(
    message,
    '<db>.backup/<basename>.<timestamp>-<pid>-<n>.bak',
    'every write after the copy you restore is lost'
  )
  expect(copies).toHaveLength(1)
  expect(copies[0]).toContain('newest')
  expect(copies[0]).toContain('keeps the newest BACKUP_KEEP copies, 5 by default')
  expect(copies[0]).toContain('Database backed up: <path>')
  // The in-app snapshot is demoted to the fallback it is: it exists only when migrations were
  // pending, so the retained one can be several upgrades stale.
  expect(copies[0]).toContain('written only when migrations were pending')
  expect(copies[0]).toContain('several upgrades old')

  // The stop step comes before the copy step, or the unit reopens the file mid-copy.
  const stop = sentencesMentioning(
    message,
    'systemctl stop synaptomind',
    'restarts the server automatically after an exit'
  )
  expect(stop).toHaveLength(1)
  expect(stop[0]).toContain('up to five starts a minute, after which it stops retrying')
  const restore = sentencesMentioning(message, 'restore the pre-upgrade backup')
  expect(restore).toHaveLength(1)
  expect(sentences.indexOf(stop[0])).toBeLessThan(sentences.indexOf(restore[0]))
  // The restore step is the one docs/DEPLOY.md prescribes, WAL and SHM sidecars included.
  expect(restore[0]).toContain('cp -p <backup> <db>')
  expect(restore[0]).toContain('rm -f <db>-wal <db>-shm')

  // The number is read for a reason: the next boot's pending migrations. Nothing is written.
  expect(restore[0]).toContain('read the number from its own _meta.schema_version row')
  expect(restore[0]).toContain('which migrations the next boot will still replay')
  expect(restore[0]).toContain('write nothing by hand')

  // The replay claim is scoped to this boot, so the next boot's replay is not contradicted.
  expect(message).not.toContain('Nothing is repaired or replayed automatically')
  const scope = sentencesMentioning(
    message,
    'this boot changed nothing and replayed nothing',
    'a later boot replays only the migrations the restored file still needs'
  )
  expect(scope).toHaveLength(1)
})

test('the no-copy branch ends with a do-not-delete step instead of a dead end', () => {
  const dbPath = freshDbPath()
  seedMigratedDb(dbPath)
  dropStamp(dbPath)

  const message = refusalMessage(() => initDb({ dbPath, runMigrations: true }))
  const sentences = sentencesOf(message)

  // The worst case is not a dead end: the file still holds the thoughts and must survive.
  const last = sentences[sentences.length - 1]
  expect(last).toContain('the thoughts in this file are intact')
  expect(last).toContain('must not be deleted or re-initialised')
  expect(last).toContain('look for a copy first')
  expect(last).toContain('<db>.backup directory next to the database file')
  expect(last).toContain('resolving a symlinked <db> to the file it points at')
  expect(last).toContain('ask before you remove or overwrite anything')
  // The sentence before it forbids guessing the number, which leaves this step as the only
  // executable one.
  expect(sentences[sentences.length - 2]).toContain('do not guess one')
})

test('the advice does not depend on the evidence list being shown in full', () => {
  // `describe()` truncates the list and appends "+N more", so advice that quoted the list could not
  // be executed on a database with more post-baseline objects than the limit. A migrated database
  // is exactly that population.
  const migratedPath = freshDbPath()
  seedMigratedDb(migratedPath)
  dropStamp(migratedPath)
  const sparsePath = preBaselineWithTables(3)
  const crowdedPath = preBaselineWithTables(32)
  const migrated = refusalMessage(() => initDb({ dbPath: migratedPath, runMigrations: true }))
  const sparse = refusalMessage(() => initDb({ dbPath: sparsePath, runMigrations: true }))
  const crowded = refusalMessage(() => initDb({ dbPath: crowdedPath, runMigrations: true }))

  // The crowded lists really are cut short: each message omits elements the database carries.
  expect(sparse).toContain('extra_03')
  expect(sparse).not.toContain('more)')
  expect(crowded).toMatch(/, \+\d+ more\)/)
  expect(migrated).toMatch(/, \+\d+ more\)/)
  const named = Array.from({ length: 32 }, (_, i) => `extra_${String(i + 1).padStart(2, '0')}`)
  expect(named.filter(name => crowded.includes(name)).length).toBeLessThan(named.length)

  // The advice is identical whichever part of the list was shown, and names no derivation from it.
  expect(adviceOf(migrated)).toBe(adviceOf(sparse))
  expect(adviceOf(crowded)).toBe(adviceOf(sparse))
  expect(adviceOf(crowded)).not.toContain('more)')
  expect(adviceOf(crowded)).not.toContain('highest version whose objects all appear')
  expect(adviceOf(crowded)).toContain('only bound how far the chain reached')
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
