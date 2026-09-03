import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { v7 as uuidv7 } from 'uuid'
import { config } from '../config'

const MAX_LOG_ROWS = 5000
const CLEANUP_INTERVAL = 100

const SENSITIVE_SUBSTRINGS = ['token', 'key', 'secret', 'password', 'auth']
const SAFE_SUBSTRINGS = ['token_count', 'tokenizer', 'tokenize', 'keyboard', 'keyring']

let db: Database | null = null
let cleanupCounter = 0
let telemetryCleanupCounter = 0
let showDebugCache: boolean | null = null
let debugCacheTime = 0
const DEBUG_CACHE_TTL = 5000

function ensureSchema(): void {
  if (!db) return
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

function ensureDb(): Database | null {
  if (db) return db
  const path = config.logDbPath
  if (!path) return null
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    db = new Database(path)
    db.run('PRAGMA journal_mode = WAL')
    db.run('PRAGMA synchronous = FULL')
    db.run('PRAGMA busy_timeout = 3000')
    ensureSchema()
    return db
  } catch (e) {
    console.warn('[logs] Failed to open logs.db:', e)
    return null
  }
}

function autoCleanup(): void {
  cleanupCounter++
  if (cleanupCounter % CLEANUP_INTERVAL !== 0) return
  if (!db) return
  try {
    db.run(
      `DELETE FROM logs WHERE id NOT IN (
        SELECT id FROM logs ORDER BY created_at DESC LIMIT ?
      )`,
      [MAX_LOG_ROWS]
    )
  } catch (e) {
    console.debug('[logs] Cleanup skipped:', e)
  }
}

function showDebugEnabled(): boolean {
  const now = Date.now()
  if (showDebugCache !== null && now - debugCacheTime < DEBUG_CACHE_TTL) {
    return showDebugCache
  }
  if (!db) return false
  try {
    const row = db.prepare("SELECT value FROM logs WHERE key = 'show_debug_logs'").get() as
      | { value: string }
      | undefined
    showDebugCache = row?.value === 'true'
    debugCacheTime = now
    return showDebugCache
  } catch {
    return false
  }
}

function sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
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

export function insertLog(
  level: string,
  type_: string,
  message: string,
  metadata?: Record<string, unknown>,
  source = 'synaptomind'
): void {
  if (level === 'debug' && !showDebugEnabled()) return
  const d = ensureDb()
  if (!d) return
  try {
    const metaCopy = metadata ? { ...metadata } : undefined
    let errorVal: string | null = null
    if (metaCopy && 'error' in metaCopy) {
      errorVal = String(metaCopy.error)
      delete metaCopy.error
    }

    const sanitized = sanitizeMetadata(metaCopy)
    const now = new Date().toISOString()
    d.run(
      'INSERT INTO logs (id, level, type, message, metadata, source, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [uuidv7(), level, type_, message, sanitized ? JSON.stringify(sanitized) : null, source, errorVal, now]
    )
    autoCleanup()
  } catch (e) {
    console.warn('[logs] Failed to insert log:', e)
  }
}

export function closeLogDb(): void {
  if (db) {
    try {
      db.close()
    } catch {
      /* ignore */
    }
    db = null
  }
  showDebugCache = null
  debugCacheTime = 0
}

export function getLogDb(): Database | null {
  return ensureDb()
}

// ── Thought telemetry ──────────────────────────────────────────────────────

const TELEMETRY_CLEANUP_INTERVAL = 100

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

function telemetryAutoCleanup(): void {
  telemetryCleanupCounter++
  if (telemetryCleanupCounter % TELEMETRY_CLEANUP_INTERVAL !== 0) return
  if (!db) return
  try {
    const row = db.prepare("SELECT value FROM logs WHERE key = 'telemetry_max_rows'").get() as
      | { value: string }
      | undefined
    const maxRows = Math.max(1000, parseInt(row?.value ?? '50000', 10) || 50000)
    db.run(
      `DELETE FROM thought_telemetry WHERE id NOT IN (
        SELECT id FROM thought_telemetry ORDER BY created_at DESC LIMIT ?
      )`,
      [maxRows]
    )
  } catch (e) {
    console.debug('[telemetry] Cleanup skipped:', e)
  }
}

export function insertTelemetry(opts: TelemetryInsertOpts): void {
  const d = ensureDb()
  if (!d) return
  try {
    const now = new Date().toISOString()
    d.run(
      `INSERT INTO thought_telemetry
         (id, correlation_id, user_id, action, tool_name, prev_tool, query, thought_id, response_size, latency_ms, session_id, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv7(),
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
    telemetryAutoCleanup()
  } catch (e) {
    console.debug('[telemetry] Insert skipped:', e)
  }
}
