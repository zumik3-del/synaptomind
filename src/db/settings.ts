import type { Database } from 'bun:sqlite'
import { config, DEFAULTS } from '../config'
import { getDb } from './container'

const SOFT_LIMIT_KEY = 'thought_soft_limit'
const HARD_LIMIT_BUFFER_PERCENT_KEY = 'thought_hard_limit_buffer_percent'
const LEGACY_HARD_LIMIT_KEY = 'thought_hard_limit'
const EMBEDDER_PRECACHE_KEY = 'embedder_precache'
const EMBEDDER_IDLE_TIMEOUT_KEY = 'embedder_idle_timeout_ms'

export interface ThoughtLimits {
  softLimit: number
  hardLimit: number
  hardLimitBufferPercent: number
}

function readMeta(db: Database, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM _meta WHERE key = ?`).get(key) as { value: string } | undefined
  return row?.value
}

function writeMeta(db: Database, key: string, value: string): void {
  db.prepare(`INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)`).run(key, value)
}

function readPositiveIntMeta(db: Database, key: string): number | undefined {
  const raw = readMeta(db, key)
  if (raw === undefined) return undefined
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function positiveIntOr(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function deriveHardLimit(softLimit: number, hardLimitBufferPercent: number): number {
  return Math.round(softLimit * (1 + hardLimitBufferPercent / 100))
}

function resolveSoftLimit(db: Database): number {
  return (
    readPositiveIntMeta(db, SOFT_LIMIT_KEY) ??
    positiveIntOr(config.thoughts.softLimit, DEFAULTS.thoughts.softLimit)
  )
}

function resolveHardLimitBufferPercent(db: Database, softLimit: number): number {
  const stored = readPositiveIntMeta(db, HARD_LIMIT_BUFFER_PERCENT_KEY)
  if (stored !== undefined) return stored

  // One-time migration from the legacy absolute hard limit (thought_hard_limit):
  // derive the equivalent buffer, rounding up so the effective ceiling never
  // drops below what was previously configured.
  const legacyHard = readPositiveIntMeta(db, LEGACY_HARD_LIMIT_KEY)
  if (legacyHard !== undefined && legacyHard > softLimit) {
    return Math.max(1, Math.ceil((legacyHard / softLimit - 1) * 100))
  }

  return positiveIntOr(config.thoughts.hardLimitBufferPercent, DEFAULTS.thoughts.hardLimitBufferPercent)
}

export function getThoughtLimitsDB(db: Database): ThoughtLimits {
  const softLimit = resolveSoftLimit(db)
  const hardLimitBufferPercent = resolveHardLimitBufferPercent(db, softLimit)
  return { softLimit, hardLimitBufferPercent, hardLimit: deriveHardLimit(softLimit, hardLimitBufferPercent) }
}

export function getThoughtLimits(): ThoughtLimits {
  return getThoughtLimitsDB(getDb())
}

// The limit advertised to agents in tool descriptions. Registration may run
// before the DB is initialized in some harnesses; fall back to config then.
export function getAdvertisedSoftLimit(): number {
  try {
    return getThoughtLimits().softLimit
  } catch {
    return positiveIntOr(config.thoughts.softLimit, DEFAULTS.thoughts.softLimit)
  }
}

export function setThoughtLimits(softLimit: number, hardLimitBufferPercent: number): ThoughtLimits {
  const db = getDb()
  writeMeta(db, SOFT_LIMIT_KEY, String(softLimit))
  writeMeta(db, HARD_LIMIT_BUFFER_PERCENT_KEY, String(hardLimitBufferPercent))
  return getThoughtLimitsDB(db)
}

export function getEmbedderPrecache(): boolean {
  const val = readMeta(getDb(), EMBEDDER_PRECACHE_KEY)
  if (!val) return config.embedder.precache
  return val === 'true'
}

export function setEmbedderPrecache(value: boolean): void {
  writeMeta(getDb(), EMBEDDER_PRECACHE_KEY, value ? 'true' : 'false')
}

export function getEmbedderIdleTimeoutMs(): number {
  const val = readMeta(getDb(), EMBEDDER_IDLE_TIMEOUT_KEY)
  if (!val) return config.embedder.idleTimeoutMs
  const parsed = parseInt(val, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : config.embedder.idleTimeoutMs
}

export function setEmbedderIdleTimeoutMs(value: number): void {
  writeMeta(getDb(), EMBEDDER_IDLE_TIMEOUT_KEY, String(value))
}
