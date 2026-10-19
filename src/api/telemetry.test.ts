/**
 * Regression tests for task #1763 (audit M5): the four telemetry HTTP routes are
 * thin adapters over `src/services/telemetry.service.ts`.
 *
 * Pinned here:
 *  - the route delegates aggregation and never touches the log DB itself,
 *  - the unified 503 body `Log database not available` (was `LOG_DB_PATH not set`),
 *  - the per-metric window floor/default and limit cap/default resolved for the
 *    HTTP query params (parity with the MCP `query` action),
 *  - absent and non-numeric query params falling back to those per-metric defaults.
 *
 * The behaviour suite mounts `telemetryRouter` directly: `createApp()` installs
 * the process-wide API rate-limit singleton (`src/middleware/rate-limit.ts:88`)
 * shared with every other `createApp()` in a `bun test` run, and this file's
 * request count would otherwise consume the 200/min quota of unrelated suites.
 * One `createApp()` request below still proves the production mount path.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { config } from '../config'
import { closeLogDb, insertTelemetry } from '../logging'
import { createApp } from './router'
import { telemetryRouter } from './telemetry'

const restartEmbedderMock = mock(() => {})

mock.module('../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: () => [new Float32Array(384)],
  restartEmbedder: restartEmbedderMock,
  isEmbedderReady: () => true
}))

process.env.SYNAPTOMIND_SECRET = 'test-token'
const router = new Hono().route('/api/telemetry', telemetryRouter)

const originalLogDbPath = config.logDbPath

function useLogDb(path: string): void {
  closeLogDb()
  config.logDbPath = path
}

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await router.request(path)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

beforeEach(() => useLogDb(':memory:'))
afterEach(closeLogDb)
afterAll(() => {
  closeLogDb()
  config.logDbPath = originalLogDbPath
})

const ROUTES = [
  '/api/telemetry/patterns',
  '/api/telemetry/frequency',
  '/api/telemetry/orphan_writes',
  '/api/telemetry/draft_lifecycle'
]

// ── production wiring (single request: shared rate-limit quota is scarce) ────

test('the app mounts the telemetry router at /api/telemetry', async () => {
  const app = createApp()
  const res = await app.request('/api/telemetry/patterns', {
    headers: { Authorization: 'Bearer test-token' }
  })
  expect(res.status).toBe(200)
  expect((await res.json()) as Record<string, unknown>).toMatchObject({ window_secs: 86_400, limit: 10 })
})

// ── delegation: each route serializes the service DTO ────────────────────────

describe('telemetry routes serialize the service report DTO', () => {
  test('GET /api/telemetry/patterns', async () => {
    insertTelemetry({ action: 'read', toolName: 'search_thoughts', prevTool: 'create_thought' })

    const { status, body } = await get('/api/telemetry/patterns')
    expect(status).toBe(200)
    expect(body).toEqual({
      window_secs: 86_400,
      limit: 10,
      patterns: [
        {
          sequence: 'create_thought → search_thoughts',
          prev_tool: 'create_thought',
          tool_name: 'search_thoughts',
          count: 1
        }
      ]
    })
  })

  test('GET /api/telemetry/frequency', async () => {
    insertTelemetry({ action: 'read', toolName: 'search_thoughts' })
    insertTelemetry({ action: 'read', toolName: 'search_thoughts' })
    insertTelemetry({ action: 'write', toolName: 'create_thought' })

    const { status, body } = await get('/api/telemetry/frequency')
    expect(status).toBe(200)
    expect(body).toEqual({
      window_secs: 86_400,
      total_calls: 3,
      per_hour: 0.1,
      by_action: { read: 2, write: 1 }
    })
  })

  test('GET /api/telemetry/orphan_writes', async () => {
    insertTelemetry({ action: 'write', toolName: 'create_thought', thoughtId: 'thought-1' })
    insertTelemetry({ action: 'write', toolName: 'update_thought', prevTool: 'search_thoughts' })

    const { status, body } = await get('/api/telemetry/orphan_writes')
    expect(status).toBe(200)
    expect(body.window_secs).toBe(86_400)
    expect(body.count).toBe(1)
    const writes = body.writes as Array<Record<string, unknown>>
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      tool_name: 'create_thought',
      prev_tool: null,
      thought_id: 'thought-1'
    })
  })

  test('GET /api/telemetry/draft_lifecycle', async () => {
    insertTelemetry({ action: 'write', toolName: 'create_thought' })

    const { status, body } = await get('/api/telemetry/draft_lifecycle')
    expect(status).toBe(200)
    expect(body).toEqual({
      window_secs: 2_592_000,
      draft_creates: 1,
      updates: 0,
      archives: 0
    })
  })
})

// ── unified 503 body (deliberate change) ─────────────────────────────────────

describe('log database unavailable', () => {
  test('every route answers the unified 503 body', async () => {
    useLogDb('')

    for (const route of ROUTES) {
      const { status, body } = await get(route)
      expect(status).toBe(503)
      expect(body).toEqual({ error: 'Log database not available' })
    }
  })
})

// ── per-metric window floor/default (deliberate change) ──────────────────────

describe('window resolution', () => {
  const WINDOW_FLOORS: Array<[string, number]> = [
    ['/api/telemetry/patterns', 60],
    ['/api/telemetry/frequency', 3_600],
    ['/api/telemetry/orphan_writes', 3_600],
    ['/api/telemetry/draft_lifecycle', 86_400]
  ]

  for (const [route, floor] of WINDOW_FLOORS) {
    test(`${route} clamps window=1 up to ${floor}s`, async () => {
      const { status, body } = await get(`${route}?window=1`)
      expect(status).toBe(200)
      expect(body.window_secs).toBe(floor)
    })
  }

  test('a window above the floor is preserved', async () => {
    const { body } = await get('/api/telemetry/patterns?window=7200')
    expect(body.window_secs).toBe(7_200)
  })

  test('absent and non-numeric windows fall back to the per-metric default', async () => {
    expect((await get('/api/telemetry/patterns')).body.window_secs).toBe(86_400)
    expect((await get('/api/telemetry/patterns?window=abc')).body.window_secs).toBe(86_400)
    expect((await get('/api/telemetry/patterns?window=')).body.window_secs).toBe(86_400)
    expect((await get('/api/telemetry/draft_lifecycle?window=abc')).body.window_secs).toBe(2_592_000)
    expect((await get('/api/telemetry/draft_lifecycle?window=')).body.window_secs).toBe(2_592_000)
  })
})

// ── per-metric limit cap/default (deliberate change) ─────────────────────────

describe('limit resolution', () => {
  test('patterns defaults to limit 10', async () => {
    const { body } = await get('/api/telemetry/patterns')
    expect(body.limit).toBe(10)
  })

  test('patterns clamps a requested limit to the 50 cap', async () => {
    const { body } = await get('/api/telemetry/patterns?limit=999')
    expect(body.limit).toBe(50)
  })

  test('absent and non-numeric limits fall back to the per-metric default', async () => {
    expect((await get('/api/telemetry/patterns?limit=xyz')).body.limit).toBe(10)
    expect((await get('/api/telemetry/patterns?limit=')).body.limit).toBe(10)
    expect((await get('/api/telemetry/patterns?limit=20')).body.limit).toBe(20)
  })
})

// ── static layering guard: the route owns no aggregation ─────────────────────

describe('thin-route guard', () => {
  // The service is the only sanctioned dependency: re-importing the log DB or
  // the aggregation queries is exactly the duplication audit M5 removed.
  const FORBIDDEN_SPECIFIER = /^(?:\.\.\/)+(?:db|logging)(?:\/|$)|^bun:sqlite$/

  test('src/api/telemetry.ts imports neither the log DB nor the aggregation queries', () => {
    const source = readFileSync(join(import.meta.dir, 'telemetry.ts'), 'utf8')
    const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1])

    expect(specifiers.filter(spec => FORBIDDEN_SPECIFIER.test(spec!))).toEqual([])
    expect(specifiers).toContain('../services/telemetry.service')
  })
})
