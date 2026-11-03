import type { Database } from 'bun:sqlite'
import { getDb, registry } from '../db'
import { getEmbedderState, type EmbedderState } from '../embedder/client-core'
import { VERSION } from '../version'

// Per-DB probe results are cached for this long (task #2286).
export const HEALTH_PROBE_TTL_MS = 30_000

interface HealthCheckResult {
  status: 'ok' | 'degraded'
  version: string
  checks: Record<string, string>
}

// 'ok' and 'not ready' are the pre-existing values; 'failed' is the added one.
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

// Track the registry shape so a change (add/remove user) invalidates stale probes.
let lastRegistryFingerprint = ''

function registryFingerprint(): string {
  return `${registry.size}:${[...registry.keys()].sort().join(',')}`
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
    // The probe's job is to observe db unavailability, so the handle is
    // resolved lazily here instead of as a trailing-`d` default (DI rule
    // deviation is deliberate — see AGENTS.md "Database DI").
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
  if (registry.size > 0) {
    return [...registry.entries()].map(([userId, db]) => ({ userId, db }))
  }
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
  let allOk = true
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

  // Imported from client-core rather than the '../embedder/client' barrel on
  // purpose: test files mock.module that specifier globally and bun cannot
  // unmock it, so the barrel here would hand out a partial mock (see
  // client.suite.ts:12). Only the lifecycle view is needed, not a request.
  checks.embedder = EMBEDDER_CHECK[getEmbedderState()]

  // Degradation stays DB-only by design: the embedder needs a long first-load
  // (model download), and the Docker healthcheck start_period (10s) is shorter,
  // so counting it would mark healthy containers unhealthy during startup. A
  // FAILED embedder is reported in checks.embedder instead, never in `status`:
  // the deploy gate fetches /health with `curl -f`, so a 503 would discard the
  // very payload that explains the failure (deploy/lib/common.sh wait_health).
  const ok = checks.database === 'ok'
  return { status: ok ? 'ok' : 'degraded', version: VERSION, checks }
}