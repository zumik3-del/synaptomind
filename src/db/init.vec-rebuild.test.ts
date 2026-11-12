import { Database } from 'bun:sqlite'
import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../config'
import { vec0Path } from '../runtime-mode'
import { drainPendingEmbeddings, seedThought } from '../test/helpers'
import { getDb } from './container'
import { closeDb, initDb, readVecIndexState } from './init'

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
  drainPendingEmbeddings([id]) // model an already-embedded thought

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
  expect(pendingIds()).toContain(id)

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

test('a rebuild that dies before the marker write is repeated on the next boot', () => {
  const dbPath = freshDbPath()
  initDb({ dbPath, runMigrations: true })
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

  // …which is what makes the next boot redo the rebuild instead of trusting it.
  openRaw(dbPath, db => db.exec(`DROP TRIGGER fail_vec_marker`))
  initDb({ dbPath, runMigrations: true })
  expect(readVecIndexState(getDb()).dimensions).toBe(REBUILT)
})
