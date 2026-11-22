import type { Database } from 'bun:sqlite'
import { getDb, getUserDb, listRegisteredUsers, listUserDatabases, registrySize } from '../db'
import { type Config, config } from '../config'
import { getEmbedderState, type EmbedderState } from '../embedder/client-core'
import { insertLog } from '../logging'
import { VERSION } from '../version'

export const HEALTH_PROBE_TTL_MS = 30_000

export type DatabaseState = 'ok' | 'degraded'

interface HealthCheckResult {
  status: 'ok' | 'degraded'
  version: string
  checks: Record<string, string>
  databases: DatabaseState[]
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
  status: DatabaseState
  error?: string
}

function recordProbeTransition(
  userId: string,
  previous: boolean | undefined,
  result: DbProbeResult
): void {
  if (previous !== undefined && previous === (result.status === 'ok')) return
  if (result.status === 'ok') {
    if (previous === false) insertLog('info', 'health', 'Database probe recovered', { userId })
    return
  }
  insertLog('warning', 'health', 'Database probe failed', {
    userId,
    ...(result.error === undefined ? {} : { error: result.error })
  })
}

export function probeDatabase(
  db: Database,
  now: number = Date.now(),
  userId: string = 'default'
): DbProbeResult {
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
  const result: DbProbeResult = ok ? { status: 'ok' } : { status: 'degraded', error }
  recordProbeTransition(userId, cached?.ok, result)
  return result
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

function unavailableConfiguredUsers(cfg: Config): string[] {
  return (cfg.users ?? []).filter(user => !getUserDb(user.id)).map(user => user.id)
}

export function getHealthService(d?: Database, cfg: Config = config): HealthCheckResult {
  invalidateCacheIfRegistryChanged()
  const checks: Record<string, string> = {}
  const now = Date.now()
  const databases: DatabaseState[] = collectDatabases(d).map(
    ({ userId, db }) => probeDatabase(db, now, userId ?? 'default').status
  )
  const unavailable = unavailableConfiguredUsers(cfg).length
  for (let i = 0; i < unavailable; i++) databases.push('degraded')

  const allOk = databases.length > 0 && databases.every(status => status === 'ok')
  checks.database = allOk ? 'ok' : 'degraded'
  checks.embedder = EMBEDDER_CHECK[getEmbedderState()]

  return { status: allOk ? 'ok' : 'degraded', version: VERSION, checks, databases }
}
