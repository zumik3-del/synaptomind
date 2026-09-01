import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { getDb } from './container'

const SOFT_LIMIT_KEY = 'thought_soft_limit'
const HARD_LIMIT_KEY = 'thought_hard_limit'
const EMBEDDER_PRECACHE_KEY = 'embedder_precache'
const EMBEDDER_IDLE_TIMEOUT_KEY = 'embedder_idle_timeout_ms'

export interface ThoughtLimits {
  softLimit: number
  hardLimit: number
}

function readMeta(db: Database, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM _meta WHERE key = ?`).get(key) as { value: string } | undefined
  return row?.value
}

function writeMeta(db: Database, key: string, value: string): void {
  db.prepare(`INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)`).run(key, value)
}

export function getThoughtLimitsDB(db: Database): ThoughtLimits {
  const softRaw = readMeta(db, SOFT_LIMIT_KEY)
  const hardRaw = readMeta(db, HARD_LIMIT_KEY)
  return {
    softLimit: softRaw ? parseInt(softRaw, 10) : config.thoughts.softLimit,
    hardLimit: hardRaw ? parseInt(hardRaw, 10) : config.thoughts.hardLimit
  }
}

export function getThoughtLimits(): ThoughtLimits {
  return getThoughtLimitsDB(getDb())
}

export function setThoughtLimits(softLimit: number, hardLimit: number): void {
  const db = getDb()
  writeMeta(db, SOFT_LIMIT_KEY, String(softLimit))
  writeMeta(db, HARD_LIMIT_KEY, String(hardLimit))
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
