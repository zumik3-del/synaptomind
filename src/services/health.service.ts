import type { Database } from 'bun:sqlite'
import { getDb } from '../db'
import { getEmbedderState, type EmbedderState } from '../embedder/client-core'
import { VERSION } from '../version'

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
