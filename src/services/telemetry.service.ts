import type { Database } from 'bun:sqlite'
import { getLogDb } from '../logging'
import {
  queryPatterns,
  queryFrequency,
  queryOrphanWritesAggregate,
  queryOrphanWritesDetail,
  queryDraftLifecycle,
  queryDraftLifecycleDetailed
} from '../db/telemetry-queries'
import { windowStart } from './utils'

export type TelemetryMetric = 'patterns' | 'frequency' | 'orphan_writes' | 'draft_lifecycle'

/**
 * Per-metric request policy shared by both protocol adapters: the window floor /
 * default and the result cap / default. Keeping it here means the HTTP query
 * params and the MCP `query` action cannot drift apart (audit M5).
 */
interface MetricSpec {
  windowMinSecs: number
  windowDefaultSecs: number
  limitMax: number
  limitDefault: number
}

const METRIC_SPECS: Record<TelemetryMetric, MetricSpec> = {
  patterns: { windowMinSecs: 60, windowDefaultSecs: 86_400, limitMax: 50, limitDefault: 10 },
  frequency: { windowMinSecs: 3_600, windowDefaultSecs: 86_400, limitMax: 100, limitDefault: 50 },
  orphan_writes: { windowMinSecs: 3_600, windowDefaultSecs: 86_400, limitMax: 500, limitDefault: 100 },
  // draft_lifecycle is not limit-bounded; its spec keeps the resolve path uniform.
  draft_lifecycle: { windowMinSecs: 86_400, windowDefaultSecs: 2_592_000, limitMax: 1_000, limitDefault: 10 }
}

export interface ResolvedWindow {
  windowSecs: number
  since: string
}

/**
 * Resolve a requested window (seconds) against the metric's floor/default and
 * compute the `since` boundary with the shared `windowStart` helper. Every
 * caller that needs a window boundary goes through here, so the math lives in
 * exactly one place.
 */
export function resolveTelemetryWindow(metric: TelemetryMetric, windowSecs?: number): ResolvedWindow {
  const spec = METRIC_SPECS[metric]
  const requested = Number.isFinite(windowSecs) ? (windowSecs as number) : spec.windowDefaultSecs
  const resolved = Math.max(spec.windowMinSecs, requested)
  return { windowSecs: resolved, since: windowStart(resolved) }
}

/** Clamp a requested result limit to the metric's cap/default. */
export function resolveTelemetryLimit(metric: TelemetryMetric, limit?: number): number {
  const spec = METRIC_SPECS[metric]
  const requested = Number.isFinite(limit) ? (limit as number) : spec.limitDefault
  return Math.min(spec.limitMax, Math.max(1, requested))
}

/**
 * Action payload or the error message to surface. Modelled as a DTO so the MCP
 * tool layer never acquires the log DB itself (findings F2/F11).
 */
type TelemetryQueryResult = { ok: true; data: unknown } | { ok: false; error: string }

type MetricHandler = (db: Database, since: string, limit: number) => unknown

const METRIC_HANDLERS: Record<TelemetryMetric, MetricHandler> = {
  patterns: queryPatterns,
  frequency: queryFrequency,
  orphan_writes: (db, since) => queryOrphanWritesAggregate(db, since),
  draft_lifecycle: (db, since) => queryDraftLifecycle(db, since)
}

/**
 * Raw aggregate rows for one metric, as returned to the MCP `query` action.
 * Resolves and validates the log DB handle internally, preserving the previous
 * error precedence (log db availability -> metric required -> invalid metric).
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

type ReportHandler = (db: Database, since: string, limit: number, windowSecs: number) => unknown

/**
 * HTTP response DTO builders. The aggregation/shaping that used to live inline
 * in `src/api/telemetry.ts` lives here; the route only serializes the DTO.
 *
 * Note: the HTTP shapes are intentionally richer than the MCP raw rows —
 * `orphan_writes` returns the offending write list (MCP returns the aggregate
 * counts) and `draft_lifecycle` returns the named lifecycle counters (MCP
 * returns raw `action`/`count` rows). See `docs/API.md` §Telemetry.
 */
const REPORT_HANDLERS: Record<TelemetryMetric, ReportHandler> = {
  patterns: (db, since, limit, windowSecs) => ({
    window_secs: windowSecs,
    limit,
    patterns: queryPatterns(db, since, limit).map(r => ({
      sequence: r.prev_tool ? `${r.prev_tool} → ${r.tool_name}` : r.tool_name,
      prev_tool: r.prev_tool,
      tool_name: r.tool_name,
      count: r.count
    }))
  }),
  frequency: (db, since, limit, windowSecs) => {
    const rows = queryFrequency(db, since, limit)
    const total = rows.reduce((sum, r) => sum + r.count, 0)
    const hours = Math.max(1, windowSecs / 3600)
    return {
      window_secs: windowSecs,
      total_calls: total,
      per_hour: Math.round((total / hours) * 10) / 10,
      by_action: Object.fromEntries(rows.map(r => [r.action, r.count]))
    }
  },
  orphan_writes: (db, since, limit, windowSecs) => {
    const rows = queryOrphanWritesDetail(db, since, limit)
    return {
      window_secs: windowSecs,
      count: rows.length,
      writes: rows.map(r => ({
        id: r.id,
        tool_name: r.tool_name,
        prev_tool: r.prev_tool,
        thought_id: r.thought_id,
        created_at: r.created_at
      }))
    }
  },
  draft_lifecycle: (db, since, _limit, windowSecs) => ({
    window_secs: windowSecs,
    ...queryDraftLifecycleDetailed(db, since)
  })
}

/**
 * Build the HTTP report DTO for one metric, resolving the log DB, the window
 * floor/default and the result cap/default internally.
 */
export function queryTelemetryReport(
  metric: TelemetryMetric,
  windowSecs?: number,
  limit?: number
): TelemetryQueryResult {
  const logDb = getLogDb()
  if (!logDb) return { ok: false, error: 'Log database not available' }
  const window = resolveTelemetryWindow(metric, windowSecs)
  return {
    ok: true,
    data: REPORT_HANDLERS[metric](logDb, window.since, resolveTelemetryLimit(metric, limit), window.windowSecs)
  }
}
