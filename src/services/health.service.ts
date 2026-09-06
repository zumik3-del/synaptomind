import type { Database } from 'bun:sqlite'
import { getDb } from '../db'
import { isEmbedderReady } from '../embedder/client'
import { VERSION } from '../version'

export interface HealthCheckResult {
  status: 'ok' | 'degraded'
  version: string
  checks: Record<string, string>
}

export function getHealthService(d?: Database): HealthCheckResult {
  const checks: Record<string, string> = {}

  try {
    // The probe's job is to observe db unavailability, so the handle is
    // resolved lazily here instead of as a trailing-`d` default (DI rule
    // deviation is deliberate — see AGENTS.md "Database DI").
    const db = d ?? getDb()
    db.prepare('SELECT 1').get()
    checks.database = 'ok'
  } catch (e) {
    checks.database = String(e)
  }

  checks.embedder = isEmbedderReady() ? 'ok' : 'not ready'

  // Degradation is DB-only by design: the embedder needs a long first-load
  // (model download), and the Docker healthcheck start_period (10s) is shorter,
  // so counting it would mark healthy containers unhealthy during startup.
  const ok = checks.database === 'ok'
  return { status: ok ? 'ok' : 'degraded', version: VERSION, checks }
}
