import { Database } from 'bun:sqlite'
import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../config'
import { vec0Path } from '../runtime-mode'
import { drainPendingEmbeddings, seedThought } from '../test/helpers'
import { getDb } from '../context/container'
import { closeDb, initDb, readVecIndexState } from './init'
import { MIGRATIONS } from './migrations'

// Regression coverage for audit F5 / #2474: `openDatabase` reshapes `vec_thoughts`
// outside the migration ledger, so a database that went through the dimension
// rebuild has to say so in `_meta` — otherwise "stored dimensions ≠ configured"
// is only inferable from a config value that the same boot already overwrote.
//
// Everything here is file-backed (the rebuild branch is skipped for `:memory:`),
// and the dimension change is a real config change replayed by a real re-open.

const CONFIGURED = config.embedder.dimensions
/** Any dimensions other than the configured ones: the rebuild renders `FLOAT[n]`. */
const REBUILT = CONFIGURED === 384 ? 512 : 384

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
    db.close()
  }
}

/** The `_meta` rows read off the file directly — no init, no service code. */
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

/** `pending_embeddings` read off the file, for the boots that never get published. */
function pendingIdsOnDisk(dbPath: string): string[] {
  return openRaw(dbPath, db =>
    (db.prepare(`SELECT thought_id FROM pending_embeddings`).all() as { thought_id: string }[]).map(
      row => row.thought_id
    )
  )
}

/** Put a real vector in `vec_thoughts` so the rebuild has an indexed row to lose. */
function seedVector(id: string): void {
  const embedding = new Float32Array(CONFIGURED)
  getDb()
    .prepare(`INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, 'default')`)
    .run(
      id,
      Buffer.from(embedding.buffer as ArrayBuffer, embedding.byteOffset, embedding.byteLength)
    )
}

/** Rows actually present in the vector index, read off the file. */
function vecRowCount(dbPath: string): number {
  return openRaw(
    dbPath,
    db => (db.prepare(`SELECT COUNT(*) AS cnt FROM vec_thoughts`).get() as { cnt: number }).cnt
  )
}

test('a fresh database records the dimensions its vector index was built with', () => {
  const dbPath = freshDbPath()
  initDb({ dbPath, runMigrations: true })

  const state = readVecIndexState(getDb())
  expect(state.dimensions).toBe(CONFIGURED)
  // Never rebuilt: no rebuild stamp to misread as one.
  expect(state.rebuiltAt).toBeNull()
  expect(metaRows(dbPath)).not.toHaveProperty('embedder_dimensions')
})

test('a mid-life dimension change is readable from _meta alone and re-queues every thought', () => {
  const dbPath = freshDbPath()
  initDb({ dbPath, runMigrations: true })
  const id = seedThought({ content: 'rebuild me' })
  seedVector(id)
  drainPendingEmbeddings([id]) // model an already-embedded thought
  expect(vecRowCount(dbPath)).toBe(1)

  config.embedder.dimensions = REBUILT
  closeDb()
  initDb({ dbPath, runMigrations: true })

  const state = readVecIndexState(getDb())
  expect(state.dimensions).toBe(REBUILT)
  expect(Date.parse(state.rebuiltAt ?? '')).toBeGreaterThan(0)

  // The table really was rebuilt at the new width, not just recorded as such.
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
  // The indexed vector did not survive the reshape; it is re-queued exactly once.
  expect(vecRowCount(dbPath)).toBe(0)
  expect(pendingIds()).toEqual([id])

  // And the rebuild is the database's own statement: a raw `_meta` read says it.
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
  // The embedder has caught up, so a second re-queue would be visible as a row.
  drainPendingEmbeddings([id])
  closeDb()

  // A write log on `_meta` turns "writes nothing" into an observation rather than
  // an absence of visible difference.
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
  // Every install that predates #2474 has the old key and nothing else.
  openRaw(dbPath, db => {
    db.exec(`UPDATE _meta SET key = 'embedder_dimensions' WHERE key = 'vec_dimensions'`)
  })

  initDb({ dbPath, runMigrations: true })

  const state = readVecIndexState(getDb())
  expect(state.dimensions).toBe(CONFIGURED)
  // An upgrade is not a rebuild: nothing was dropped and nothing was re-queued.
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
  drainPendingEmbeddings([id]) // the embedder has caught up again
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

  // The migration really ran instead of being skipped…
  const version = getDb().prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get() as {
    value: string
  }
  expect(version.value).toBe(String(newest))
  // …and the marker came through untouched, so nothing was rebuilt again.
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
  // The marker is written last, so a crash here leaves the old dimensions behind…
  expect(() => initDb({ dbPath, runMigrations: true })).toThrow('simulated marker failure')
  expect(metaRows(dbPath).vec_dimensions).toBe(String(CONFIGURED))

  // …while the destructive part already happened: empty table at the new width and a
  // queued thought. Re-queuing a queued thought is idempotent, so the retry cannot
  // double it.
  expect(vecRowCount(dbPath)).toBe(0)
  expect(pendingIdsOnDisk(dbPath)).toEqual([id])

  // The stale marker is what makes the next boot redo the rebuild instead of
  // trusting a half-reset index.
  openRaw(dbPath, db => db.exec(`DROP TRIGGER fail_vec_marker`))
  initDb({ dbPath, runMigrations: true })
  const state = readVecIndexState(getDb())
  expect(state.dimensions).toBe(REBUILT)
  expect(Date.parse(state.rebuiltAt ?? '')).toBeGreaterThan(0)
  expect(pendingIds()).toEqual([id])
  expect(vecRowCount(dbPath)).toBe(0)
})
