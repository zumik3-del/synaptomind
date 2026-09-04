import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from '../config'
import { clearDb, getDb, setDb } from './container'
import { MIGRATIONS } from './migrations'

let vecLoaded = false

const VEC0_PATH = `${import.meta.dir}/../../vec0.so`

function loadVecExtension(database: Database, isMemory: boolean): void {
  if (isMemory) return
  try {
    database.loadExtension(VEC0_PATH)
  } catch {
    throw new Error(
      `vec0 extension failed to load from ${VEC0_PATH}. ` +
        'Install the sqlite-vec package or build vec0.so for your platform.'
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

  if (!isMemory) {
    db.run('PRAGMA journal_mode = WAL')
  }
  db.run('PRAGMA busy_timeout = 15000')
  db.run('PRAGMA foreign_keys = ON')

  loadVecExtension(db, isMemory)

  const d = db // guaranteed non-null from here

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
      created_at  TEXT NOT NULL,
      is_git_linked INTEGER DEFAULT 0,
      git_repo_url TEXT,
      git_auto_sync INTEGER DEFAULT 0,
      git_sync_interval_ms INTEGER
    )
  `)

  d.run(`
    CREATE TABLE IF NOT EXISTS _meta (
      key   TEXT PRIMARY KEY,
      value TEXT
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
      vecLoaded = true
    } catch (err) {
      if (isMemory) return
      throw err
    }
  }

  const getVersion = (): number => {
    const row = d.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined
    return row ? parseInt(row.value, 10) : 0
  }

  const setVersion = (version: number): void => {
    d.prepare(
      `INSERT INTO _meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(String(version))
  }

  let current = getVersion()

  for (const migration of MIGRATIONS) {
    if (current >= migration.version) continue
    const run = d.transaction(() => migration.apply(d, { isMemory, dimensions }))
    run()
    setVersion(migration.version)
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
      console.log(
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

  d.run(`UPDATE pending_embeddings SET is_error = 0, error = NULL WHERE is_error = 1`)

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
    const id = crypto.randomUUID()
    d.prepare(`INSERT INTO _meta (key, value) VALUES ('default_project_id', ?)`).run(id)
    d.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, 'Default', ?)`).run(id, new Date().toISOString())
  }

  setDb(db)
}

export function hasVec(): boolean {
  return vecLoaded
}

export function closeDb(): void {
  try {
    getDb().close()
  } catch {
    // ignore close errors
  }
  clearDb()
  vecLoaded = false
}
