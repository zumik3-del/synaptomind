import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from '../config'
import { vec0Path } from '../runtime-mode'
import { clearDb, getDb, setDb } from './container'
import { MIGRATIONS } from './migrations'

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

interface InitOptions {
  dbPath?: string
  runMigrations?: boolean
}

export function initDb(dbPathOrOptions?: string | InitOptions): void {
  const opts: InitOptions = typeof dbPathOrOptions === 'string' ? { dbPath: dbPathOrOptions } : (dbPathOrOptions ?? {})
  const resolvedPath = opts.dbPath ?? config.db.path
  const runMigrations = opts.runMigrations ?? false
  const isMemory = resolvedPath === ':memory:'

  mkdirSync(dirname(resolvedPath), { recursive: true })
  const db = new Database(resolvedPath)

  const busyTimeout = Number.isFinite(config.db.busyTimeout) ? Math.max(0, Math.floor(config.db.busyTimeout)) : 5000
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
    database.prepare(
      `INSERT INTO _meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(String(version))
  }

  let current = getVersion(db)
  const maxVersion = MIGRATIONS.length > 0 ? Math.max(...MIGRATIONS.map(m => m.version)) : 0
  if (current > maxVersion) {
    // The handle was never published through `setDb`, so `closeDb()` cannot
    // reach it: close it here or the connection (and its file handle) leaks
    // for the lifetime of the process.
    db.close(true)
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
    setDb(db)
    return
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

  // v11 (runtime): track embedder dimensions
  if (!isMemory) {
    const storedDims = d.prepare(`SELECT value FROM _meta WHERE key = 'embedder_dimensions'`).get() as
      | { value: string }
      | undefined
    if (!storedDims) {
      d.prepare(`INSERT INTO _meta (key, value) VALUES ('embedder_dimensions', ?)`).run(String(dimensions))
    } else if (parseInt(storedDims.value, 10) !== dimensions) {
      console.error(
        `[db] dimensions changed ${storedDims.value} → ${dimensions}, rebuilding vec_thoughts (all embeddings will be re-generated)`
      )
      d.run(`DROP TABLE IF EXISTS vec_thoughts`)
      runVecSchema()
      d.prepare(`UPDATE _meta SET value = ? WHERE key = 'embedder_dimensions'`).run(String(dimensions))
      d.run(`
        INSERT OR IGNORE INTO pending_embeddings (thought_id, created_at)
        SELECT id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM thoughts WHERE status != 'archived'
      `)
    }
  }

  // Dead letters are NOT reset on boot by default: a permanently poisonous
  // thought would otherwise get MAX_ATTEMPTS fresh tries on every restart and
  // loop forever. Recovery after a fix is opt-in via config/env.
  if (config.embedder.resetDeadLetters) {
    d.run(`UPDATE pending_embeddings SET is_error = 0, error = NULL WHERE is_error = 1`)
  }

  // Ensure default project exists — recover if _meta points to a deleted project
  const defaultMeta = d.prepare(`SELECT value FROM _meta WHERE key = 'default_project_id'`).get() as
    | { value: string }
    | undefined
  if (defaultMeta?.value) {
    const exists = d.prepare(`SELECT 1 FROM projects WHERE id = ?`).get(defaultMeta.value)
    if (!exists) {
      console.error(`[db] Default project ${defaultMeta.value} missing — recreating`)
      d.prepare(`INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, 'Default', ?)`).run(
        defaultMeta.value,
        new Date().toISOString()
      )
    }
  } else {
    const id = Bun.randomUUIDv7()
    d.prepare(`INSERT INTO _meta (key, value) VALUES ('default_project_id', ?)`).run(id)
    d.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, 'Default', ?)`).run(id, new Date().toISOString())
  }

  setDb(db)
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
