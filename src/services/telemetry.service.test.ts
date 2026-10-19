import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { config } from '../config'
import { closeLogDb, insertTelemetry } from '../logging'
import {
  queryTelemetryMetric,
  queryTelemetryReport,
  resolveTelemetryLimit,
  resolveTelemetryWindow,
  type TelemetryMetric
} from './telemetry.service'

// Regression coverage for task #165 (F2/F11): the telemetry service, not the
// MCP tool, owns the log-db handle and must preserve the previous error
// precedence (log db availability -> metric required -> invalid metric).
const originalLogDbPath = config.logDbPath

function useLogDb(path: string): void {
  closeLogDb()
  config.logDbPath = path
}

const SINCE = new Date(Date.now() - 86_400_000).toISOString()

beforeEach(() => useLogDb(':memory:'))
afterEach(closeLogDb)
afterAll(() => {
  closeLogDb()
  config.logDbPath = originalLogDbPath
})

describe('queryTelemetryMetric', () => {
  test('reports an unavailable log database', () => {
    useLogDb('')
    expect(queryTelemetryMetric('frequency', SINCE, 10)).toEqual({
      ok: false,
      error: 'Log database not available'
    })
  })

  test('checks log-db availability before the metric argument', () => {
    useLogDb('')
    // Both cases would otherwise produce a metric error; the log-db error wins.
    expect(queryTelemetryMetric(undefined, SINCE, 10)).toEqual({
      ok: false,
      error: 'Log database not available'
    })
    expect(queryTelemetryMetric('bogus' as TelemetryMetric, SINCE, 10)).toEqual({
      ok: false,
      error: 'Log database not available'
    })
  })

  test('requires a metric when the log database is available', () => {
    expect(queryTelemetryMetric(undefined, SINCE, 10)).toEqual({
      ok: false,
      error: 'metric is required for query action'
    })
  })

  test('rejects an unknown metric', () => {
    expect(queryTelemetryMetric('bogus' as TelemetryMetric, SINCE, 10)).toEqual({
      ok: false,
      error: 'Invalid metric'
    })
  })

  test('returns frequency aggregates for a valid metric', () => {
    insertTelemetry({ action: 'read', toolName: 'search_thoughts' })
    insertTelemetry({ action: 'write', toolName: 'create_thought' })
    insertTelemetry({ action: 'write', toolName: 'create_thought' })

    const result = queryTelemetryMetric('frequency', SINCE, 10)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const rows = (result.data as Array<{ action: string; count: number }>)
      .map(r => ({ action: r.action, count: r.count }))
      .sort((a, b) => a.action.localeCompare(b.action))
    expect(rows).toEqual([
      { action: 'read', count: 1 },
      { action: 'write', count: 2 }
    ])
  })

  test('returns patterns rows and an empty draft_lifecycle', () => {
    insertTelemetry({ action: 'read', toolName: 'search_thoughts', prevTool: 'create_thought' })

    const patterns = queryTelemetryMetric('patterns', SINCE, 10)
    expect(patterns.ok).toBe(true)
    if (patterns.ok) {
      expect(patterns.data).toEqual([
        { prev_tool: 'create_thought', tool_name: 'search_thoughts', count: 1 }
      ])
    }

    const lifecycle = queryTelemetryMetric('draft_lifecycle', SINCE, 10)
    expect(lifecycle).toEqual({ ok: true, data: [] })
  })
})

// ── shared per-metric request policy (task #1763, audit M5) ──────────────────
//
// Both adapters (HTTP query params and the MCP `query` action) resolve the
// window floor/default and the result cap/default here, so these values are the
// single source of truth the deliberate behaviour changes are pinned against.

describe('resolveTelemetryWindow', () => {
  const WINDOW_FLOORS: Array<[TelemetryMetric, number]> = [
    ['patterns', 60],
    ['frequency', 3_600],
    ['orphan_writes', 3_600],
    ['draft_lifecycle', 86_400]
  ]

  const WINDOW_DEFAULTS: Array<[TelemetryMetric, number]> = [
    ['patterns', 86_400],
    ['frequency', 86_400],
    ['orphan_writes', 86_400],
    ['draft_lifecycle', 2_592_000]
  ]

  for (const [metric, expected] of WINDOW_DEFAULTS) {
    test(`${metric} defaults to a ${expected}s window`, () => {
      const before = Date.now()
      const resolved = resolveTelemetryWindow(metric)
      const after = Date.now()

      expect(resolved.windowSecs).toBe(expected)
      const sinceMs = Date.parse(resolved.since)
      expect(sinceMs).toBeGreaterThanOrEqual(before - expected * 1000)
      expect(sinceMs).toBeLessThanOrEqual(after - expected * 1000)
    })
  }

  for (const [metric, floor] of WINDOW_FLOORS) {
    test(`${metric} clamps a requested window up to its ${floor}s floor`, () => {
      expect(resolveTelemetryWindow(metric, 1).windowSecs).toBe(floor)
      expect(resolveTelemetryWindow(metric, floor - 1).windowSecs).toBe(floor)
    })
  }

  test('keeps a requested window above the floor', () => {
    expect(resolveTelemetryWindow('patterns', 7_200).windowSecs).toBe(7_200)
    expect(resolveTelemetryWindow('draft_lifecycle', 3_000_000).windowSecs).toBe(3_000_000)
  })

  test('falls back to the metric default for a non-finite window', () => {
    expect(resolveTelemetryWindow('frequency', Number.NaN).windowSecs).toBe(86_400)
    expect(resolveTelemetryWindow('draft_lifecycle', Number.NaN).windowSecs).toBe(2_592_000)
  })
})

describe('resolveTelemetryLimit', () => {
  const LIMIT_DEFAULTS: Array<[TelemetryMetric, number]> = [
    ['patterns', 10],
    ['frequency', 50],
    ['orphan_writes', 100],
    ['draft_lifecycle', 10]
  ]

  const LIMIT_CAPS: Array<[TelemetryMetric, number]> = [
    ['patterns', 50],
    ['frequency', 100],
    ['orphan_writes', 500],
    ['draft_lifecycle', 1_000]
  ]

  for (const [metric, expected] of LIMIT_DEFAULTS) {
    test(`${metric} defaults to a limit of ${expected}`, () => {
      expect(resolveTelemetryLimit(metric)).toBe(expected)
      expect(resolveTelemetryLimit(metric, Number.NaN)).toBe(expected)
    })
  }

  for (const [metric, cap] of LIMIT_CAPS) {
    test(`${metric} clamps a requested limit to its ${cap} cap`, () => {
      expect(resolveTelemetryLimit(metric, 9_999)).toBe(cap)
      expect(resolveTelemetryLimit(metric, cap + 1)).toBe(cap)
    })
  }

  test('keeps a requested limit inside (0, cap]', () => {
    expect(resolveTelemetryLimit('patterns', 20)).toBe(20)
    expect(resolveTelemetryLimit('patterns', 50)).toBe(50)
  })

  test('floors a requested limit at 1', () => {
    expect(resolveTelemetryLimit('patterns', 0)).toBe(1)
    expect(resolveTelemetryLimit('patterns', -5)).toBe(1)
  })
})

describe('queryTelemetryReport', () => {
  const METRICS: TelemetryMetric[] = ['patterns', 'frequency', 'orphan_writes', 'draft_lifecycle']

  test('reports an unavailable log database for every metric', () => {
    useLogDb('')
    for (const metric of METRICS) {
      expect(queryTelemetryReport(metric)).toEqual({
        ok: false,
        error: 'Log database not available'
      })
    }
  })

  test('builds the patterns report with resolved window and limit', () => {
    insertTelemetry({ action: 'read', toolName: 'search_thoughts', prevTool: 'create_thought' })
    insertTelemetry({ action: 'read', toolName: 'search_thoughts', prevTool: 'create_thought' })
    // An empty prev_tool (falsy, but not NULL) renders the bare tool name.
    insertTelemetry({ action: 'read', toolName: 'get_thought', prevTool: '' })

    const result = queryTelemetryReport('patterns')
    expect(result).toEqual({
      ok: true,
      data: {
        window_secs: 86_400,
        limit: 10,
        patterns: [
          {
            sequence: 'create_thought → search_thoughts',
            prev_tool: 'create_thought',
            tool_name: 'search_thoughts',
            count: 2
          },
          { sequence: 'get_thought', prev_tool: '', tool_name: 'get_thought', count: 1 }
        ]
      }
    })
  })

  test('patterns report applies the window floor and the limit cap', () => {
    insertTelemetry({ action: 'read', toolName: 'search_thoughts', prevTool: 'create_thought' })

    const result = queryTelemetryReport('patterns', 1, 9_999)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toMatchObject({ window_secs: 60, limit: 50 })
  })

  test('builds the frequency report (totals, rate and per-action counts)', () => {
    insertTelemetry({ action: 'read', toolName: 'search_thoughts' })
    insertTelemetry({ action: 'read', toolName: 'search_thoughts' })
    insertTelemetry({ action: 'write', toolName: 'create_thought' })

    expect(queryTelemetryReport('frequency')).toEqual({
      ok: true,
      data: {
        window_secs: 86_400,
        total_calls: 3,
        per_hour: 0.1,
        by_action: { read: 2, write: 1 }
      }
    })
  })

  test('builds the orphan_writes report as the offending write list', () => {
    insertTelemetry({ action: 'write', toolName: 'create_thought', thoughtId: 'thought-1' })
    insertTelemetry({ action: 'write', toolName: 'update_thought', prevTool: 'search_thoughts' })

    const result = queryTelemetryReport('orphan_writes')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const data = result.data as {
      window_secs: number
      count: number
      writes: Array<Record<string, unknown>>
    }
    expect(data.window_secs).toBe(86_400)
    expect(data.count).toBe(1)
    expect(data.writes).toHaveLength(1)
    expect(data.writes[0]).toMatchObject({
      tool_name: 'create_thought',
      prev_tool: null,
      thought_id: 'thought-1'
    })
    expect(typeof data.writes[0]!.id).toBe('string')
    expect(typeof data.writes[0]!.created_at).toBe('string')
  })

  test('builds the draft_lifecycle report with named counters and the 30-day default', () => {
    insertTelemetry({ action: 'write', toolName: 'create_thought' })
    insertTelemetry({ action: 'write', toolName: 'update_thought', meta: { status: 'active' } })
    insertTelemetry({ action: 'write', toolName: 'archive_thought' })

    expect(queryTelemetryReport('draft_lifecycle')).toEqual({
      ok: true,
      data: {
        window_secs: 2_592_000,
        draft_creates: 1,
        updates: 1,
        archives: 1
      }
    })
  })
})
