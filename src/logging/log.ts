import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { config as appConfig } from '../config'

const MAX_LOG_ROWS = 5000
const CLEANUP_INTERVAL = 100

const SENSITIVE_SUBSTRINGS = ['token', 'key', 'secret', 'password', 'auth']
const SAFE_SUBSTRINGS = ['token_count', 'tokenizer', 'tokenize', 'keyboard', 'keyring']

const DEBUG_CACHE_TTL = 5000
const TELEMETRY_CLEANUP_INTERVAL = 100

type LogLevel = 'debug' | 'info' | 'warning' | 'error'

export interface TelemetryInsertOpts {
  correlationId?: string
  userId?: string
  action: 'read' | 'write' | 'link' | 'explore'
  toolName: string
  prevTool?: string
  query?: string
  thoughtId?: string
  responseSize?: number
  latencyMs?: number
  sessionId?: string
  meta?: Record<string, unknown>
}

export class LogStore {
  private db: Database | null = null
  private cleanupCounter = 0
  private telemetryCleanupCounter = 0
  private showDebugCache: boolean | null = null
  private debugCacheTime = 0

  constructor(private config: { logDbPath: string } = appConfig) {}

  private ensureSchema(): void {
    if (!this.db) return
    this.db.exec(`
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
    this.db.exec(`
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
      this.ensureSchema()
      return this.db
    } catch (e) {
      console.warn('[logs] Failed to open logs.db:', e)
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

  // ── Thought telemetry ──────────────────────────────────────────────────────

  private telemetryAutoCleanup(): void {
    this.telemetryCleanupCounter++
    if (this.telemetryCleanupCounter % TELEMETRY_CLEANUP_INTERVAL !== 0) return
    if (!this.db) return
    try {
      const maxRows = 50000
      this.db.run(
        `DELETE FROM thought_telemetry WHERE id NOT IN (
          SELECT id FROM thought_telemetry ORDER BY created_at DESC LIMIT ?
        )`,
        [maxRows]
      )
    } catch (e) {
      console.debug('[telemetry] Cleanup skipped:', e)
    }
  }

  insertTelemetry(opts: TelemetryInsertOpts): void {
    const d = this.ensureDb()
    if (!d) return
    try {
      const now = new Date().toISOString()
      d.run(
        `INSERT INTO thought_telemetry
           (id, correlation_id, user_id, action, tool_name, prev_tool, query, thought_id, response_size, latency_ms, session_id, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Bun.randomUUIDv7(),
          opts.correlationId ?? null,
          opts.userId ?? null,
          opts.action,
          opts.toolName,
          opts.prevTool ?? null,
          opts.query ?? null,
          opts.thoughtId ?? null,
          opts.responseSize ?? null,
          opts.latencyMs ?? null,
          opts.sessionId ?? null,
          opts.meta ? JSON.stringify(opts.meta) : null,
          now
        ]
      )
      this.telemetryAutoCleanup()
    } catch (e) {
      console.debug('[telemetry] Insert skipped:', e)
    }
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

export function insertTelemetry(opts: TelemetryInsertOpts): void {
  defaultStore.insertTelemetry(opts)
}
