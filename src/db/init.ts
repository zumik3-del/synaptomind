import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from '../config'
import { vec0Path } from '../runtime-mode'
import { clearDb, getDb, setDb } from '../context/container'
import { MIGRATIONS } from './migrations'
import { backupDatabase } from './backup'
import { BASELINE_TABLE_DDL, META_DDL } from './baseline-schema'
import { readSchemaVersion } from './schema-stamp'
import { vecTableDdl } from './vec-schema'

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

const VEC_DIMENSIONS_KEY = 'vec_dimensions'
const VEC_REBUILD_AT_KEY = 'vec_rebuild_at'
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

export function readVecIndexState(db: Database): VecIndexState {
  const stored = metaValue(db, VEC_DIMENSIONS_KEY) ?? metaValue(db, LEGACY_DIMENSIONS_KEY)
  const parsed = stored === null ? Number.NaN : parseInt(stored, 10)
  return {
    dimensions: Number.isFinite(parsed) ? parsed : null,
    rebuiltAt: metaValue(db, VEC_REBUILD_AT_KEY)
  }
}

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

    // `_meta` must exist before the version guard, and nothing else may run before it: an older
    // binary has to refuse a newer database before any step that could reshape it.
    db.run(META_DDL)

    const setVersion = (database: Database, version: number): void => {
      database
        .prepare(
          `INSERT INTO _meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        )
        .run(String(version))
    }

    let current = readSchemaVersion(db)
    const maxVersion = MIGRATIONS.length > 0 ? Math.max(...MIGRATIONS.map(m => m.version)) : 0
    if (current > maxVersion) {
      throw new Error(
        `Database schema version ${current} is newer than this binary supports (max ${maxVersion}). ` +
          'Restore from a backup taken before the upgrade or upgrade the binary.'
      )
    }

    if (!isMemory) {
      db.run('PRAGMA journal_mode = WAL')
    }

    loadVecExtension(db, isMemory)

    const d = db

    for (const ddl of BASELINE_TABLE_DDL) d.run(ddl)

    if (!runMigrations) {
      success = true
      return db
    }

    const dimensions = config.embedder.dimensions
    const runVecSchema = (): void => {
      try {
        d.run(vecTableDdl(dimensions))
      } catch (err) {
        if (isMemory) return
        throw err
      }
    }

    // A snapshot must precede every irreversible step: the migration chain reshapes tables, and the
    // dimension rebuild below drops `vec_thoughts`. One snapshot per boot serves both.
    let backupTaken = false
    const snapshot = (targetVersion: number): void => {
      backupDatabase(db, resolvedPath, targetVersion)
      backupTaken = true
    }

    if (!isMemory) {
      const pendingMigrations = MIGRATIONS.filter(m => m.version > current)
      if (pendingMigrations.length > 0) {
        snapshot(Math.max(...pendingMigrations.map(m => m.version)))
      }
    }

    for (const migration of MIGRATIONS) {
      if (current >= migration.version) continue
      // Apply and stamp in one transaction: a crash between them must not leave a non-idempotent
      // migration half-applied with the old version recorded.
      const run = d.transaction(() => {
        migration.apply(d, { isMemory, dimensions })
        setVersion(d, migration.version)
      })
      run()
      current = migration.version
    }

    if (!isMemory) {
      const vec = readVecIndexState(d)
      const rebuilt = vec.dimensions !== null && vec.dimensions !== dimensions
      if (rebuilt) {
        // A pending-migration snapshot already covers this DROP; otherwise take one now, so a
        // failed backup aborts the rebuild before the vectors are thrown away.
        if (!backupTaken) snapshot(current)
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
      if (rebuilt || vec.dimensions === null || metaValue(d, LEGACY_DIMENSIONS_KEY) !== null) {
        writeVecIndexState(d, dimensions, rebuilt ? new Date().toISOString() : null)
      }
    }

    // Dead letters are not reset on boot by default: a permanently poisonous thought would get
    // MAX_ATTEMPTS fresh tries on every restart and loop forever.
    if (config.embedder.resetDeadLetters) {
      d.run(`UPDATE pending_embeddings SET is_error = 0, error = NULL WHERE is_error = 1`)
    }

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
      } catch {}
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
