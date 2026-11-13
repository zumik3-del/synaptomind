import { Database } from 'bun:sqlite'
import { afterAll, afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { config } from '../config'
import { vec0Path } from '../runtime-mode'
import { drainPendingEmbeddings, seedThought } from '../test/helpers'
import { getDb } from '../context/container'
import { closeDb, initDb, readVecIndexState } from './init'
import { MIGRATIONS } from './migrations'

const CONFIGURED = config.embedder.dimensions
const REBUILT = CONFIGURED === 384 ? 512 : 384
const NEWEST = Math.max(...MIGRATIONS.map(m => m.version))

const tmpRoot = mkdtempSync(join(tmpdir(), 'synaptomind-vec-rebuild-'))
let cases = 0

afterEach(() => {
  config.embedder.dimensions = CONFIGURED
  closeDb()
})

afterAll(() => {
  config.embedder.dimensions = CONFIGURED
  closeDb()
  rmSync(tmpRoot, { recursive: true, force: true })
})

function caseDir(name: string): string {
  const dir = join(tmpRoot, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

function freshDbPath(): string {
  cases += 1
  return join(tmpRoot, `case-${cases}.db`)
}

function backupsOf(dbPath: string): string[] {
  const prefix = `${basename(dbPath)}.pre-v`
  return readdirSync(dirname(dbPath)).filter(name => name.startsWith(prefix))
}

function openRaw<T>(dbPath: string, fn: (db: Database) => T): T {
  const db = new Database(dbPath)
  try {
    db.loadExtension(vec0Path())
    return fn(db)
  } finally {
    db.close()
  }
}

function metaRows(dbPath: string): Record<string, string> {
  return openRaw(dbPath, db => {
    const rows = db.prepare(`SELECT key, value FROM _meta`).all() as {
      key: string
      value: string
    }[]
    return Object.fromEntries(rows.map(row => [row.key, row.value]))
  })
}

function pendingIds(): string[] {
  const rows = getDb().prepare(`SELECT thought_id FROM pending_embeddings`).all() as {
    thought_id: string
  }[]
  return rows.map(row => row.thought_id)
}

function pendingIdsOnDisk(dbPath: string): string[] {
  return openRaw(dbPath, db =>
    (db.prepare(`SELECT thought_id FROM pending_embeddings`).all() as { thought_id: string }[]).map(
      row => row.thought_id
    )
  )
}

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

function seedVector(id: string): void {
  const embedding = new Float32Array(CONFIGURED)
  getDb()
    .prepare(`INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, 'default')`)
    .run(
      id,
      Buffer.from(embedding.buffer as ArrayBuffer, embedding.byteOffset, embedding.byteLength)
    )
}

function vecRowCount(dbPath: string): number {
  return openRaw(
    dbPath,
    db => (db.prepare(`SELECT COUNT(*) AS cnt FROM vec_thoughts`).get() as { cnt: number }).cnt
  )
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

test('a fresh database records the dimensions its vector index was built with', () => {
  const dbPath = freshDbPath()
  initDb({ dbPath, runMigrations: true })

  const state = readVecIndexState(getDb())
  expect(state.dimensions).toBe(CONFIGURED)
  expect(state.rebuiltAt).toBeNull()
  expect(metaRows(dbPath)).not.toHaveProperty('embedder_dimensions')
})

test('a mid-life dimension change is readable from _meta alone and re-queues every thought', () => {
  const dbPath = freshDbPath()
  initDb({ dbPath, runMigrations: true })
  const id = seedThought({ content: 'rebuild me' })
  seedVector(id)
  drainPendingEmbeddings([id])
  expect(vecRowCount(dbPath)).toBe(1)

  config.embedder.dimensions = REBUILT
  closeDb()
  initDb({ dbPath, runMigrations: true })

  const state = readVecIndexState(getDb())
  expect(state.dimensions).toBe(REBUILT)
  expect(Date.parse(state.rebuiltAt ?? '')).toBeGreaterThan(0)

  const ddl = openRaw(
    dbPath,
    db =>
      (
        db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'vec_thoughts'`).get() as {
          sql: string
        }
      ).sql
  )
  expect(ddl).toContain(`FLOAT[${REBUILT}]`)
  // The rebuild renders its DDL from `vec-schema.ts`; it must keep the partition
  // column too, or every project-scoped query fails against the reshaped table
  // (the seed above runs before the rebuild, so width alone cannot catch it).
  expect(ddl).toContain('PARTITION KEY')
  expect(vecRowCount(dbPath)).toBe(0)
  expect(pendingIds()).toEqual([id])

  closeDb()
  const meta = metaRows(dbPath)
  expect(meta.vec_dimensions).toBe(String(REBUILT))
  expect(Date.parse(meta.vec_rebuild_at)).toBeGreaterThan(0)
})

test('a repeat open with unchanged dimensions writes no _meta row and re-queues nothing', () => {
  const dbPath = freshDbPath()
  initDb({ dbPath, runMigrations: true })
  const id = seedThought({ content: 'stay put' })
  config.embedder.dimensions = REBUILT
  closeDb()
  initDb({ dbPath, runMigrations: true })
  const rebuiltAt = readVecIndexState(getDb()).rebuiltAt
  drainPendingEmbeddings([id])
  closeDb()

  openRaw(dbPath, db => {
    db.exec(`CREATE TABLE meta_write_log (key TEXT NOT NULL, op TEXT NOT NULL)`)
    db.exec(
      `CREATE TRIGGER log_meta_insert AFTER INSERT ON _meta
         BEGIN INSERT INTO meta_write_log VALUES (NEW.key, 'insert'); END`
    )
    db.exec(
      `CREATE TRIGGER log_meta_update AFTER UPDATE ON _meta
         BEGIN INSERT INTO meta_write_log VALUES (NEW.key, 'update'); END`
    )
    db.exec(
      `CREATE TRIGGER log_meta_delete AFTER DELETE ON _meta
         BEGIN INSERT INTO meta_write_log VALUES (OLD.key, 'delete'); END`
    )
  })

  initDb({ dbPath, runMigrations: true })

  expect(getDb().prepare(`SELECT key, op FROM meta_write_log`).all()).toEqual([])
  expect(readVecIndexState(getDb()).rebuiltAt).toBe(rebuiltAt)
  expect(pendingIds()).toEqual([])
})

test('a database carrying only the legacy dimension marker upgrades without a rebuild', () => {
  const dbPath = freshDbPath()
  initDb({ dbPath, runMigrations: true })
  closeDb()
  openRaw(dbPath, db => {
    db.exec(`UPDATE _meta SET key = 'embedder_dimensions' WHERE key = 'vec_dimensions'`)
  })

  initDb({ dbPath, runMigrations: true })

  const state = readVecIndexState(getDb())
  expect(state.dimensions).toBe(CONFIGURED)
  expect(state.rebuiltAt).toBeNull()
  const meta = metaRows(dbPath)
  expect(meta.vec_dimensions).toBe(String(CONFIGURED))
  expect(meta).not.toHaveProperty('embedder_dimensions')
})

test('a legacy marker that disagrees with the configuration still rebuilds and retires', () => {
  const dbPath = freshDbPath()
  initDb({ dbPath, runMigrations: true })
  const id = seedThought({ content: 'legacy but stale' })
  seedVector(id)
  drainPendingEmbeddings([id])
  closeDb()
  openRaw(dbPath, db => {
    db.exec(`UPDATE _meta SET key = 'embedder_dimensions' WHERE key = 'vec_dimensions'`)
  })

  // Ignoring the legacy key here would read "no marker", skip the rebuild and stamp
  // the *configured* dimensions onto a table still shaped for the old ones.
  config.embedder.dimensions = REBUILT
  initDb({ dbPath, runMigrations: true })

  const state = readVecIndexState(getDb())
  expect(state.dimensions).toBe(REBUILT)
  expect(state.rebuiltAt).not.toBeNull()
  expect(vecRowCount(dbPath)).toBe(0)
  expect(pendingIds()).toEqual([id])
  expect(metaRows(dbPath)).not.toHaveProperty('embedder_dimensions')
})

test('the rebuild marker outlives a migration replayed after it was written', () => {
  const dbPath = freshDbPath()
  initDb({ dbPath, runMigrations: true })
  const id = seedThought({ content: 'survive a version bump' })
  seedVector(id)
  drainPendingEmbeddings([id])
  config.embedder.dimensions = REBUILT
  closeDb()
  initDb({ dbPath, runMigrations: true })
  const rebuiltAt = readVecIndexState(getDb()).rebuiltAt
  expect(rebuiltAt).not.toBeNull()
  drainPendingEmbeddings([id])
  closeDb()

  // Rewind one version so the next boot takes the ordinary migration path: this is
  // the "later version bump" the boot-owned marker has to come through untouched.
  // Otherwise a migration that reshapes `_meta` silently forgets the rebuild and the
  // next boot redoes the whole re-embed (or trusts a stale width).
  const newest = Math.max(...MIGRATIONS.map(m => m.version))
  openRaw(dbPath, db => {
    db.prepare(`UPDATE _meta SET value = ? WHERE key = 'schema_version'`).run(String(newest - 1))
  })

  initDb({ dbPath, runMigrations: true })

  const version = getDb().prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get() as {
    value: string
  }
  expect(version.value).toBe(String(newest))
  const state = readVecIndexState(getDb())
  expect(state.dimensions).toBe(REBUILT)
  expect(state.rebuiltAt).toBe(rebuiltAt)
  expect(metaRows(dbPath).vec_dimensions).toBe(String(REBUILT))
  expect(pendingIds()).toEqual([])
  expect(vecRowCount(dbPath)).toBe(0)
})

test('a rebuild that dies before the marker write is repeated on the next boot', () => {
  const dbPath = freshDbPath()
  initDb({ dbPath, runMigrations: true })
  const id = seedThought({ content: 'crash mid-rebuild' })
  seedVector(id)
  drainPendingEmbeddings([id])
  closeDb()
  openRaw(dbPath, db => {
    db.exec(
      `CREATE TRIGGER fail_vec_marker BEFORE INSERT ON _meta
         WHEN NEW.key = 'vec_dimensions'
         BEGIN SELECT RAISE(ABORT, 'simulated marker failure'); END`
    )
  })

  config.embedder.dimensions = REBUILT
  expect(() => initDb({ dbPath, runMigrations: true })).toThrow('simulated marker failure')
  expect(metaRows(dbPath).vec_dimensions).toBe(String(CONFIGURED))

  expect(vecRowCount(dbPath)).toBe(0)
  expect(pendingIdsOnDisk(dbPath)).toEqual([id])

  openRaw(dbPath, db => db.exec(`DROP TRIGGER fail_vec_marker`))
  initDb({ dbPath, runMigrations: true })
  const state = readVecIndexState(getDb())
  expect(state.dimensions).toBe(REBUILT)
  expect(Date.parse(state.rebuiltAt ?? '')).toBeGreaterThan(0)
  expect(pendingIds()).toEqual([id])
  expect(vecRowCount(dbPath)).toBe(0)
})

test('a dimension change snapshots the vectors before dropping vec_thoughts', () => {
  const dbPath = freshDbPath()
  initDb({ dbPath, runMigrations: true })
  const id = seedThought({ content: 'keep my vector' })
  seedVector(id)
  drainPendingEmbeddings([id])
  closeDb()
  for (const stale of backupsOf(dbPath)) {
    rmSync(join(dirname(dbPath), stale))
  }
  expect(backupsOf(dbPath)).toEqual([])

  config.embedder.dimensions = REBUILT
  initDb({ dbPath, runMigrations: true })

  const snapshots = backupsOf(dbPath)
  expect(snapshots).toEqual([expect.stringContaining(`.pre-v${NEWEST}.rebuild.`)])
  const snapshotPath = join(dirname(dbPath), snapshots[0])
  expect(vecDdl(snapshotPath)).toContain(`FLOAT[${CONFIGURED}]`)
  expect(openRaw(snapshotPath, db => db.prepare(`SELECT id FROM vec_thoughts`).all())).toEqual([
    { id }
  ])

  expect(vecDdl(dbPath)).toContain(`FLOAT[${REBUILT}]`)
  expect(vecRowCount(dbPath)).toBe(0)
  expect(pendingIds()).toEqual([id])
})

test('a boot that already took a migration snapshot takes no second rebuild snapshot', () => {
  const dbPath = freshDbPath()
  initDb({ dbPath, runMigrations: true })
  const id = seedThought({ content: 'replay then flip' })
  closeDb()
  for (const stale of backupsOf(dbPath)) {
    rmSync(join(dirname(dbPath), stale))
  }
  expect(backupsOf(dbPath)).toEqual([])

  // A replayed v048 copies whatever vectors it finds into the reshaped table, so no vector is
  // seeded: the width flip below is then the only state the rebuild has to carry across.
  openRaw(dbPath, db =>
    db.prepare(`UPDATE _meta SET value = ? WHERE key = 'schema_version'`).run(String(NEWEST - 1))
  )
  config.embedder.dimensions = REBUILT
  initDb({ dbPath, runMigrations: true })

  // The pre-migration snapshot already predates the DROP, so the rebuild takes none of its own.
  const snapshots = backupsOf(dbPath)
  expect(snapshots).toHaveLength(1)
  expect(snapshots[0]).toContain(`.pre-v${NEWEST}.`)
  expect(snapshots[0]).not.toContain('.rebuild.')

  expect(readVecIndexState(getDb()).rebuiltAt).not.toBeNull()
  expect(vecDdl(dbPath)).toContain(`FLOAT[${REBUILT}]`)
  expect(pendingIds()).toEqual([id])
})

test('a failed snapshot aborts the rebuild with the vectors still in place', () => {
  // A root process ignores the directory mode, so it cannot make the snapshot fail this way.
  if (process.getuid?.() === 0) return

  const dir = caseDir('failed-snapshot')
  const dbPath = join(dir, 'test.db')
  initDb({ dbPath, runMigrations: true })
  const id = seedThought({ content: 'keep my vector' })
  seedVector(id)
  drainPendingEmbeddings([id])
  closeDb()
  for (const stale of backupsOf(dbPath)) {
    rmSync(join(dir, stale))
  }
  // No migration is pending, so the only snapshot this boot can take is the rebuild's.
  expect(metaRows(dbPath).schema_version).toBe(String(NEWEST))

  config.embedder.dimensions = REBUILT

  // A live connection keeps the WAL sidecars on disk, so the boot below reaches the snapshot;
  // without them `PRAGMA journal_mode = WAL` fails on the read-only directory first and the
  // rebuild is never attempted.
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

  // A rebuild snapshot is a copy of this file at the version it is already at: the message must
  // name that version as current, never as the version this boot was moving the schema to.
  expect(message).toContain(
    `Database backup failed before rebuilding the vector index (the schema is at v${NEWEST})`
  )
  expect(message).not.toContain('moving the schema to')
  expect(message).not.toContain(`(schema v${NEWEST})`)

  expect(backupsOf(dbPath)).toEqual([])
  expect(vecDdl(dbPath)).toContain(`FLOAT[${CONFIGURED}]`)
  expect(vecRowCount(dbPath)).toBe(1)
  expect(pendingIdsOnDisk(dbPath)).toEqual([])
  expect(metaRows(dbPath).vec_dimensions).toBe(String(CONFIGURED))
})
