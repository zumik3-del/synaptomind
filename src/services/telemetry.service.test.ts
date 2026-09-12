import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { config } from '../config'
import { closeLogDb, insertTelemetry } from '../logging'
import { queryTelemetryMetric, type TelemetryMetric } from './telemetry.service'

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
