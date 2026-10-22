import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { config as appConfig } from '../config'

const MAX_LOG_ROWS = 5000
const CLEANUP_INTERVAL = 100

const SENSITIVE_SUBSTRINGS = ['token', 'key', 'secret', 'password', 'auth']
const SAFE_SUBSTRINGS = ['token_count', 'tokenizer', 'tokenize', 'keyboard', 'keyring']

const DEBUG_CACHE_TTL = 5000

type LogLevel = 'debug' | 'info' | 'warning' | 'error'

// ── logs.db schema policy (audit M2) ────────────────────────────────────────
//
// logs.db is a separate SQLite file from the main synaptomind.db, so it carries
// its own `schema_version` in its own `_meta` table. Evolve it the same way as
// the main DB (src/db/init.ts): APPEND a migration to LOG_MIGRATIONS, never edit
// an applied one, and let `ensureSchema` apply the pending ones forward-only
// inside one transaction each. `CREATE TABLE IF NOT EXISTS` on its own is not an
// evolution path: on an already-deployed logs.db it is a silent no-op, which is
// exactly the drift this policy removes.
interface LogMigration {
  version: number
  apply: (db: Database) => void
}

const LOG_MIGRATIONS: LogMigration[] = [
  {
    version: 1,
    apply: db => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS logs (
          id         TEXT PRIMARY KEY,
          level      TEXT NOT NULL,
          type       TEXT NOT NULL,
          message    TEXT NOT NULL,
          metadata   TEXT,
          source     TEXT,
          error      TEXT,
          created_at TEXT NOT NULL
        )
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS thought_telemetry (
          id            TEXT PRIMARY KEY,
          correlation_id TEXT,
          user_id       TEXT,
          action        TEXT NOT NULL,
          tool_name     TEXT NOT NULL,
          prev_tool     TEXT,
          query         TEXT,
          thought_id    TEXT,
          response_size INTEGER,
          latency_ms    INTEGER,
          session_id    TEXT,
          meta          TEXT,
          created_at    TEXT NOT NULL
        )
      `)
    }
  },
  {
    // The telemetry collection is gone (ADR 2026-10-21): after the detection
    // signal layer was collapsed, `thought_telemetry` had no reader left. The
    // table is dropped here rather than left orphaned, so every deployed
    // logs.db is cleaned by the same forward-only path. `logs` is untouched.
    version: 2,
    apply: db => {
      db.exec(`DROP TABLE IF EXISTS thought_telemetry`)
    }
  }
]

const SCHEMA_VERSION_KEY = 'schema_version'

function getSchemaVersion(db: Database): number {
  const row = db.prepare(`SELECT value FROM _meta WHERE key = ?`).get(SCHEMA_VERSION_KEY) as
    | { value: string }
    | undefined
  return row ? parseInt(row.value, 10) : 0
}

function setSchemaVersion(db: Database, version: number): void {
  db.prepare(
    `INSERT INTO _meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(SCHEMA_VERSION_KEY, String(version))
}

export class LogStore {
  private db: Database | null = null
  private cleanupCounter = 0
  private showDebugCache: boolean | null = null
  private debugCacheTime = 0

  constructor(private config: { logDbPath: string } = appConfig) {}

  private ensureSchema(db: Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)`)
    let current = getSchemaVersion(db)
    for (const migration of LOG_MIGRATIONS) {
      if (current >= migration.version) continue
      // Apply the DDL and stamp its schema_version in one transaction, so a crash
      // between the two cannot leave a non-idempotent migration half-applied.
      const run = db.transaction(() => {
        migration.apply(db)
        setSchemaVersion(db, migration.version)
      })
      run()
      current = migration.version
    }
  }

  private ensureDb(): Database | null {
    if (this.db) return this.db
    const path = this.config.logDbPath
    if (!path) return null
    try {
      mkdirSync(join(path, '..'), { recursive: true })
      this.db = new Database(path)
      this.db.run('PRAGMA journal_mode = WAL')
      this.db.run('PRAGMA synchronous = FULL')
      this.db.run('PRAGMA busy_timeout = 3000')
      this.ensureSchema(this.db)
      return this.db
    } catch (e) {
      console.warn('[logs] Failed to open logs.db:', e)
      // Do not leave a half-initialized handle behind: without this reset the next
      // getLogDb() would return the poisoned connection instead of retrying.
      try {
        this.db?.close()
      } catch {
        /* ignore */
      }
      this.db = null
      return null
    }
  }

  private autoCleanup(): void {
    this.cleanupCounter++
    if (this.cleanupCounter % CLEANUP_INTERVAL !== 0) return
    if (!this.db) return
    try {
      this.db.run(
        `DELETE FROM logs WHERE id NOT IN (
          SELECT id FROM logs ORDER BY created_at DESC LIMIT ?
        )`,
        [MAX_LOG_ROWS]
      )
    } catch (e) {
      console.debug('[logs] Cleanup skipped:', e)
    }
  }

  private showDebugEnabled(): boolean {
    const now = Date.now()
    if (this.showDebugCache !== null && now - this.debugCacheTime < DEBUG_CACHE_TTL) {
      return this.showDebugCache
    }
    this.showDebugCache = process.env.SYNAPTOMIND_DEBUG === 'true'
    this.debugCacheTime = now
    return this.showDebugCache
  }

  private sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!metadata) return metadata
    const cleaned: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(metadata)) {
      const kl = k.toLowerCase()
      if (SENSITIVE_SUBSTRINGS.some(sub => kl.includes(sub)) && !SAFE_SUBSTRINGS.some(sub => kl.includes(sub))) {
        cleaned[k] = '***'
      } else {
        cleaned[k] = v
      }
    }
    return cleaned
  }

  insertLog(
    level: LogLevel,
    type_: string,
    message: string,
    metadata?: Record<string, unknown>,
    source = 'synaptomind'
  ): void {
    if (level === 'debug' && !this.showDebugEnabled()) return
    const d = this.ensureDb()
    if (!d) return
    try {
      const metaCopy = metadata ? { ...metadata } : undefined
      let errorVal: string | null = null
      if (metaCopy && 'error' in metaCopy) {
        errorVal = String(metaCopy.error)
        delete metaCopy.error
      }

      const sanitized = this.sanitizeMetadata(metaCopy)
      const now = new Date().toISOString()
      d.run(
        'INSERT INTO logs (id, level, type, message, metadata, source, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [Bun.randomUUIDv7(), level, type_, message, sanitized ? JSON.stringify(sanitized) : null, source, errorVal, now]
      )
      this.autoCleanup()
    } catch (e) {
      console.warn('[logs] Failed to insert log:', e)
    }
  }

  closeLogDb(): void {
    if (this.db) {
      try {
        this.db.close()
      } catch {
        /* ignore */
      }
      this.db = null
    }
    this.showDebugCache = null
    this.debugCacheTime = 0
  }

  getLogDb(): Database | null {
    return this.ensureDb()
  }
}

const defaultStore = new LogStore()

export function insertLog(
  level: LogLevel,
  type_: string,
  message: string,
  metadata?: Record<string, unknown>,
  source = 'synaptomind'
): void {
  defaultStore.insertLog(level, type_, message, metadata, source)
}

export function closeLogDb(): void {
  defaultStore.closeLogDb()
}

export function getLogDb(): Database | null {
  return defaultStore.getLogDb()
}
