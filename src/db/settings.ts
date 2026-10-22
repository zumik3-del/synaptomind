import type { Database } from 'bun:sqlite'
import { config, DEFAULTS } from '../config'

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

/**
 * Config-only soft limit: the value to advertise when no database is available.
 * Exported so the service layer can degrade to config when tool registration
 * runs before `initDb()` in some harnesses.
 */
export function configuredSoftLimit(): number {
  return positiveIntOr(config.thoughts.softLimit, DEFAULTS.thoughts.softLimit)
}

export function getThoughtLimitsDB(db: Database): ThoughtLimits {
  const softLimit = resolveSoftLimit(db)
  const hardLimitBufferPercent = resolveHardLimitBufferPercent(db, softLimit)
  return { softLimit, hardLimitBufferPercent, hardLimit: deriveHardLimit(softLimit, hardLimitBufferPercent) }
}

// `getThoughtLimitsDB` is the implementation shared with the thought/cluster
// services; this entry point keeps the unsuffixed name for the settings service.
export function getThoughtLimits(db: Database): ThoughtLimits {
  return getThoughtLimitsDB(db)
}

// The limit advertised to agents in tool descriptions. The pre-init fallback
// lives in the service layer (getAdvertisedSoftLimitService): a db-first
// function has no database to fall back from.
export function getAdvertisedSoftLimit(db: Database): number {
  return getThoughtLimits(db).softLimit
}

export function setThoughtLimits(db: Database, softLimit: number, hardLimitBufferPercent: number): ThoughtLimits {
  writeMeta(db, SOFT_LIMIT_KEY, String(softLimit))
  writeMeta(db, HARD_LIMIT_BUFFER_PERCENT_KEY, String(hardLimitBufferPercent))
  return getThoughtLimitsDB(db)
}

export function getEmbedderPrecache(db: Database): boolean {
  const val = readMeta(db, EMBEDDER_PRECACHE_KEY)
  if (!val) return config.embedder.precache
  return val === 'true'
}

export function getEmbedderIdleTimeoutMs(db: Database): number {
  const val = readMeta(db, EMBEDDER_IDLE_TIMEOUT_KEY)
  if (!val) return config.embedder.idleTimeoutMs
  const parsed = parseInt(val, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : config.embedder.idleTimeoutMs
}
