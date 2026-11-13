import type { Database } from 'bun:sqlite'
import {
  getDb,
  getUserDb,
  listRegisteredUsers,
  listUserDatabases,
  registrySize
} from '../context/container'
import { config } from '../config'
import { getEmbedderState, type EmbedderState } from '../embedder/client-core'
import { VERSION } from '../version'

export const HEALTH_PROBE_TTL_MS = 30_000

interface HealthCheckResult {
  status: 'ok' | 'degraded'
  version: string
  checks: Record<string, string>
}

const EMBEDDER_CHECK: Record<EmbedderState, string> = {
  ok: 'ok',
  starting: 'not ready',
  stopped: 'not ready',
  failed: 'failed'
}

interface CachedProbe {
  ok: boolean
  error?: string
  expiresAt: number
}

const probeCache = new Map<Database, CachedProbe>()

let lastRegistryFingerprint = ''

function registryFingerprint(): string {
  return `${registrySize()}:${listRegisteredUsers().sort().join(',')}`
}

function invalidateCacheIfRegistryChanged(): void {
  const fp = registryFingerprint()
  if (fp !== lastRegistryFingerprint) {
    probeCache.clear()
    lastRegistryFingerprint = fp
  }
}

export interface DbProbeResult {
  status: 'ok' | 'degraded'
  error?: string
}

export function probeDatabase(db: Database, now: number = Date.now()): DbProbeResult {
  const cached = probeCache.get(db)
  if (cached && cached.expiresAt > now) {
    return cached.ok ? { status: 'ok' } : { status: 'degraded', error: cached.error }
  }
  let ok = true
  let error: string | undefined
  try {
    db.prepare('SELECT 1').get()
  } catch (e) {
    ok = false
    error = String(e)
  }
  probeCache.set(db, { ok, error, expiresAt: now + HEALTH_PROBE_TTL_MS })
  return ok ? { status: 'ok' } : { status: 'degraded', error }
}

export function clearHealthProbeCache(): void {
  probeCache.clear()
  lastRegistryFingerprint = registryFingerprint()
}

function collectDatabases(d?: Database): Array<{ userId?: string; db: Database }> {
  invalidateCacheIfRegistryChanged()
  const entries = listUserDatabases()
  if (entries.length > 0) return entries
  try {
    return [{ db: d ?? getDb() }]
  } catch {
    return []
  }
}

export function getHealthService(d?: Database): HealthCheckResult {
  invalidateCacheIfRegistryChanged()
  const checks: Record<string, string> = {}

  const dbs = collectDatabases(d)
  let allOk = !(config.users?.length && config.users.some(user => !getUserDb(user.id)))
  if (dbs.length === 0) {
    checks.database = 'degraded'
    allOk = false
  } else {
    for (const { db } of dbs) {
      const probe = probeDatabase(db)
      if (probe.status !== 'ok') allOk = false
    }
    checks.database = allOk ? 'ok' : 'degraded'
  }

  checks.embedder = EMBEDDER_CHECK[getEmbedderState()]

  const ok = checks.database === 'ok'
  return { status: ok ? 'ok' : 'degraded', version: VERSION, checks }
}
