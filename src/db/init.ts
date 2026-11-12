import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from '../config'
import { vec0Path } from '../runtime-mode'
import { clearDb, getDb, setDb } from '../context/container'
import { MIGRATIONS } from './migrations'
import { backupDatabase } from './backup'

function loadVecExtension(database: Database, isMemory: boolean): void {
  if (isMemory) return
  const vec0 = vec0Path()
  try {
    database.loadExtension(vec0)
  } catch {
    throw new Error(
      `vec0 extension failed to load from ${vec0}. ` +
        'Place vec0.so next to the synaptomind executable (or in the repository root ' +
        'when running from source), or point SYNAPTOMIND_VEC0_PATH at it.'
    )
  }
}

export interface InitOptions {
  dbPath?: string
  runMigrations?: boolean
}

/** Dimensions the current `vec_thoughts` table was built with. */
const VEC_DIMENSIONS_KEY = 'vec_dimensions'
/** ISO timestamp of the last dimension-change rebuild; absent when never rebuilt. */
const VEC_REBUILD_AT_KEY = 'vec_rebuild_at'
/** Pre-#2474 name for `vec_dimensions`; read-only from here on. */
const LEGACY_DIMENSIONS_KEY = 'embedder_dimensions'

export interface VecIndexState {
  dimensions: number | null
  rebuiltAt: string | null
}

function metaValue(db: Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM _meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

/**
 * Boot state that the migration ledger does not own (audit F5): which dimensions
 * `vec_thoughts` was built with, and when it was last rebuilt. Reading it makes
 * "stored dimensions ≠ configured" a `_meta` read instead of an inference; a
 * `dimensions` of null means the marker is absent (never opened by this binary
 * and no legacy key), so the table must be assumed to match the configuration.
 */
export function readVecIndexState(db: Database): VecIndexState {
  // An existing database carries the legacy key only: read it as the same fact so
  // an upgrade never rebuilds, and the next write retires it.
  const stored = metaValue(db, VEC_DIMENSIONS_KEY) ?? metaValue(db, LEGACY_DIMENSIONS_KEY)
  const parsed = stored === null ? Number.NaN : parseInt(stored, 10)
  return {
    dimensions: Number.isFinite(parsed) ? parsed : null,
    rebuiltAt: metaValue(db, VEC_REBUILD_AT_KEY)
  }
}

/**
 * Record which dimensions the vector index holds. `rebuiltAt` is set only when the
 * table was just rebuilt; null leaves the key alone. Called last in the rebuild so
 * a crash leaves the old dimensions in place and the next boot repeats the work
 * instead of hiding a half-reset index.
 */
function writeVecIndexState(db: Database, dimensions: number, rebuiltAt: string | null): void {
  const upsert = db.prepare(
    `INSERT INTO _meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
  upsert.run(VEC_DIMENSIONS_KEY, String(dimensions))
  if (rebuiltAt !== null) upsert.run(VEC_REBUILD_AT_KEY, rebuiltAt)
  db.prepare(`DELETE FROM _meta WHERE key = ?`).run(LEGACY_DIMENSIONS_KEY)
}

export function openDatabase(dbPathOrOptions?: string | InitOptions): Database {
  const opts: InitOptions =
    typeof dbPathOrOptions === 'string' ? { dbPath: dbPathOrOptions } : (dbPathOrOptions ?? {})
  const resolvedPath = opts.dbPath ?? config.db.path
  const runMigrations = opts.runMigrations ?? false
  const isMemory = resolvedPath === ':memory:'

  mkdirSync(dirname(resolvedPath), { recursive: true })
  const db = new Database(resolvedPath)

  let success = false
  try {
    const busyTimeout = Number.isFinite(config.db.busyTimeout)
      ? Math.max(0, Math.floor(config.db.busyTimeout))
      : 5000
    db.run(`PRAGMA busy_timeout = ${busyTimeout}`)
    db.run('PRAGMA foreign_keys = ON')

    // Only `_meta` is bootstrapped before the schema-version guard: an older
    // binary must refuse a newer database BEFORE any step that could reshape it
    // (WAL switch, bootstrap DDL, migrations). `CREATE TABLE IF NOT EXISTS` is a
    // no-op on a database that already has it.
    db.run(`
    CREATE TABLE IF NOT EXISTS _meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `)

    const getVersion = (database: Database): number => {
      const row = database.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get() as
        | { value: string }
        | undefined
      return row ? parseInt(row.value, 10) : 0
    }

    const setVersion = (database: Database, version: number): void => {
      database
        .prepare(
          `INSERT INTO _meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        )
        .run(String(version))
    }

    let current = getVersion(db)
    const maxVersion = MIGRATIONS.length > 0 ? Math.max(...MIGRATIONS.map(m => m.version)) : 0
    if (current > maxVersion) {
      // The handle was never published through `setDb`, so `closeDb()` cannot
      // reach it: the finally block below closes it before rethrowing.
      throw new Error(
        `Database schema version ${current} is newer than this binary supports (max ${maxVersion}). ` +
          'Restore from a backup taken before the upgrade or upgrade the binary.'
      )
    }

    if (!isMemory) {
      db.run('PRAGMA journal_mode = WAL')
    }

    loadVecExtension(db, isMemory)

    const d = db // guaranteed non-null from here

    // Bootstrap tables for non-migration mode (tests, memory DB).
    // In production (runMigrations=true), the migration system owns the full schema
    // and will ALTER TABLE to add any missing columns.
    d.run(`
    CREATE TABLE IF NOT EXISTS thoughts (
      id         TEXT PRIMARY KEY,
      content    TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'draft',
      source     TEXT,
      project_id TEXT,
      is_cluster INTEGER DEFAULT 0,
      is_profile INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

    d.run(`
    CREATE TABLE IF NOT EXISTS edges (
      id         TEXT PRIMARY KEY,
      source_id  TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
      target_id  TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
      type       TEXT NOT NULL DEFAULT 'related',
      created_at TEXT NOT NULL,
      UNIQUE(source_id, target_id, type)
    )
  `)

    d.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      created_at  TEXT NOT NULL
    )
  `)

    d.run(`
    CREATE TABLE IF NOT EXISTS preview_tokens (
      token       TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,
      target_id   TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      expires_at  TEXT NOT NULL
    )
  `)

    if (!runMigrations) {
      success = true
      return db
    }

    const dimensions = config.embedder.dimensions
    const runVecSchema = (): void => {
      try {
        d.run(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_thoughts USING vec0(
        id        TEXT PRIMARY KEY,
        embedding FLOAT[${dimensions}] distance_metric=cosine
      )`)
      } catch (err) {
        if (isMemory) return
        throw err
      }
    }

    // Back up the database before any pending migration runs: migrations are the
    // only irreversible step, so a snapshot is only taken when there is work to
    // do. `:memory:` databases and the test bootstrap path (runMigrations=false,
    // which returns earlier) never reach here.
    if (!isMemory) {
      const pendingMigrations = MIGRATIONS.filter(m => m.version > current)
      if (pendingMigrations.length > 0) {
        const targetVersion = Math.max(...pendingMigrations.map(m => m.version))
        backupDatabase(db, resolvedPath, targetVersion)
      }
    }

    for (const migration of MIGRATIONS) {
      if (current >= migration.version) continue
      // Apply the migration and stamp its schema_version in one transaction: a crash
      // between the two must not leave a non-idempotent migration half-applied (audit H1).
      const run = d.transaction(() => {
        migration.apply(d, { isMemory, dimensions })
        setVersion(d, migration.version)
      })
      run()
      current = migration.version
    }

    // Three boot-time owners, none of them the ledger: the migrations own
    // `schema_version`, this branch owns `vec_dimensions`/`vec_rebuild_at` and the
    // embedding re-queue, `resetDeadLetters` owns `pending_embeddings.is_error`,
    // and the default-project branch owns `default_project_id` plus its row.
    if (!isMemory) {
      const vec = readVecIndexState(d)
      const rebuilt = vec.dimensions !== null && vec.dimensions !== dimensions
      if (rebuilt) {
        console.error(
          `[db] dimensions changed ${vec.dimensions} → ${dimensions}, rebuilding vec_thoughts (all embeddings will be re-generated)`
        )
        d.run(`DROP TABLE IF EXISTS vec_thoughts`)
        runVecSchema()
        d.run(`
          INSERT OR IGNORE INTO pending_embeddings (thought_id, created_at)
          SELECT id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM thoughts WHERE status != 'archived'
        `)
      }
      // A rebuild, a fresh install and an upgrade from the legacy key all land here;
      // a steady-state boot (`vec_dimensions` current, legacy key gone) writes nothing.
      if (rebuilt || vec.dimensions === null || metaValue(d, LEGACY_DIMENSIONS_KEY) !== null) {
        writeVecIndexState(d, dimensions, rebuilt ? new Date().toISOString() : null)
      }
    }

    // Dead letters are NOT reset on boot by default: a permanently poisonous
    // thought would otherwise get MAX_ATTEMPTS fresh tries on every restart and
    // loop forever. Recovery after a fix is opt-in via config/env.
    if (config.embedder.resetDeadLetters) {
      d.run(`UPDATE pending_embeddings SET is_error = 0, error = NULL WHERE is_error = 1`)
    }

    // Ensure default project exists — recover if _meta points to a deleted project
    const defaultMeta = d
      .prepare(`SELECT value FROM _meta WHERE key = 'default_project_id'`)
      .get() as { value: string } | undefined
    if (defaultMeta?.value) {
      const exists = d.prepare(`SELECT 1 FROM projects WHERE id = ?`).get(defaultMeta.value)
      if (!exists) {
        console.error(`[db] Default project ${defaultMeta.value} missing — recreating`)
        d.prepare(
          `INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, 'Default', ?)`
        ).run(defaultMeta.value, new Date().toISOString())
      }
    } else {
      const id = Bun.randomUUIDv7()
      d.prepare(`INSERT INTO _meta (key, value) VALUES ('default_project_id', ?)`).run(id)
      d.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, 'Default', ?)`).run(
        id,
        new Date().toISOString()
      )
    }

    success = true
    return db
  } finally {
    if (!success) {
      try {
        db.close(true)
      } catch {
        // best-effort cleanup on throw path
      }
    }
  }
}

export function initDb(dbPathOrOptions?: string | InitOptions): Database {
  const db = openDatabase(dbPathOrOptions)
  setDb(db)
  return db
}

export function closeDb(): void {
  let db: ReturnType<typeof getDb> | null = null
  try {
    db = getDb()
  } catch {
    // DB never initialized (or already closed): nothing to do.
    clearDb()
    return
  }
  try {
    db.run('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch (err) {
    console.error('[db] wal_checkpoint(TRUNCATE) failed:', err)
  }
  try {
    db.close(true)
  } catch (err) {
    console.error('[db] close failed:', err)
  }
  clearDb()
}
