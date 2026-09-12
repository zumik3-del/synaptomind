import type { Database } from 'bun:sqlite'
import { getLogDb } from '../logging'
import {
  queryPatterns,
  queryFrequency,
  queryOrphanWritesAggregate,
  queryDraftLifecycle
} from './telemetry-queries'

export type TelemetryMetric = 'patterns' | 'frequency' | 'orphan_writes' | 'draft_lifecycle'

/**
 * Action payload or the error message to surface. Modelled as a DTO so the MCP
 * tool layer never acquires the log DB itself (findings F2/F11).
 */
export type TelemetryQueryResult = { ok: true; data: unknown } | { ok: false; error: string }

type MetricHandler = (db: Database, since: string, limit: number) => unknown

const METRIC_HANDLERS: Record<TelemetryMetric, MetricHandler> = {
  patterns: queryPatterns,
  frequency: queryFrequency,
  orphan_writes: (db, since) => queryOrphanWritesAggregate(db, since),
  draft_lifecycle: (db, since) => queryDraftLifecycle(db, since)
}

/**
 * Query an aggregate metric from the telemetry log DB. Resolves and validates
 * the log DB handle internally, preserving the previous error messages.
 */
export function queryTelemetryMetric(
  metric: TelemetryMetric | undefined,
  since: string,
  limit: number
): TelemetryQueryResult {
  const logDb = getLogDb()
  if (!logDb) return { ok: false, error: 'Log database not available' }
  if (!metric) return { ok: false, error: 'metric is required for query action' }
  const handler = METRIC_HANDLERS[metric]
  if (!handler) return { ok: false, error: 'Invalid metric' }
  return { ok: true, data: handler(logDb, since, limit) }
}
