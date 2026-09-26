/**
 * Regression tests for #853: withTelemetry consistency across /api routes.
 *
 * - Each instrumented route writes exactly one telemetry row on a normal call.
 * - Routes called with X-Client: mcp write zero rows (MCP instruments directly).
 * - Excluded routes (stats, settings) write zero rows regardless of header.
 * - Covers tags, projects, frontier and a representative write/read/link action.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { closeDb } from '../db/init'
import { config } from '../config'
import { closeLogDb, getLogDb } from '../logging'
import { createTestDb } from '../test/helpers'
import { createApp } from './router'

const restartEmbedderMock = mock(() => {})

mock.module('../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: () => [new Float32Array(384)],
  restartEmbedder: restartEmbedderMock,
  isEmbedderReady: () => true,
}))

process.env.SYNAPTOMIND_SECRET = 'test-token'
const app = createApp()

// ── helpers ───────────────────────────────────────────────────────────────────

function useMemoryLogDb(): void {
  closeLogDb()
  config.logDbPath = ':memory:'
}

interface TelemetryRow {
  action: string
  tool_name: string
  session_id: string | null
  meta: string | null
}

function telemetryRows(): TelemetryRow[] {
  const db = getLogDb()
  if (!db) throw new Error('log db unavailable')
  return db.query('SELECT action, tool_name, session_id, meta FROM thought_telemetry ORDER BY rowid').all() as TelemetryRow[]
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', 'Bearer test-token')
  return app.request(path, { ...init, headers })
}

beforeEach(createTestDb)
beforeEach(useMemoryLogDb)
afterEach(closeDb)
afterEach(async () => {
  // Clear telemetry rows between tests to isolate each request.
  try {
    const db = getLogDb()
    if (db) db.run('DELETE FROM thought_telemetry')
  } catch { /* log db may be closed */ }
})

afterAll(() => {
  closeLogDb()
  config.logDbPath = ':memory:'
})

// ── single-row per call ───────────────────────────────────────────────────────

describe('withTelemetry writes exactly one row per instrumented call', () => {
  test('GET /api/tags lists tags and writes one read row', async () => {
    const res = await request('/api/tags')
    expect(res.status).toBe(200)
    expect(telemetryRows()).toHaveLength(1)
    expect(telemetryRows()[0]!.action).toBe('read')
    expect(telemetryRows()[0]!.tool_name).toBe('list_tags')
  })

  test('GET /api/frontier writes one read row', async () => {
    const res = await request('/api/frontier')
    expect(res.status).toBe(200)
    expect(telemetryRows()).toHaveLength(1)
    expect(telemetryRows()[0]!.action).toBe('read')
    expect(telemetryRows()[0]!.tool_name).toBe('get_frontier')
  })

  test('GET /api/projects lists projects and writes one read row', async () => {
    const res = await request('/api/projects')
    expect(res.status).toBe(200)
    expect(telemetryRows()).toHaveLength(1)
    expect(telemetryRows()[0]!.action).toBe('read')
    expect(telemetryRows()[0]!.tool_name).toBe('list_projects')
  })

  test('POST /api/thoughts creates a thought and writes one write row', async () => {
    const res = await request('/api/thoughts', {
      method: 'POST',
      body: JSON.stringify({ content: 'telemetry probe' }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(201)
    expect(telemetryRows()).toHaveLength(1)
    expect(telemetryRows()[0]!.action).toBe('write')
    expect(telemetryRows()[0]!.tool_name).toBe('create_thought')
  })

  test('POST /api/cluster creates a cluster and writes one write row', async () => {
    const a = (await (await request('/api/thoughts', {
      method: 'POST', body: JSON.stringify({ content: 'a' }),
      headers: { 'Content-Type': 'application/json' },
    })).json()) as { id: string }
    const b = (await (await request('/api/thoughts', {
      method: 'POST', body: JSON.stringify({ content: 'b' }),
      headers: { 'Content-Type': 'application/json' },
    })).json()) as { id: string }
    const before = telemetryRows().length
    const res = await request('/api/cluster', {
      method: 'POST',
      body: JSON.stringify({ thought_ids: [a.id, b.id], title: 'test' }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(201)
    expect(telemetryRows().length - before).toBe(1)
    expect(telemetryRows()[telemetryRows().length - 1]!.action).toBe('write')
    expect(telemetryRows()[telemetryRows().length - 1]!.tool_name).toBe('cluster')
  })

  test('POST /api/thoughts/:id/link writes one link row', async () => {
    const src = (await (await request('/api/thoughts', {
      method: 'POST', body: JSON.stringify({ content: 'src' }),
      headers: { 'Content-Type': 'application/json' },
    })).json()) as { id: string }
    const tgt = (await (await request('/api/thoughts', {
      method: 'POST', body: JSON.stringify({ content: 'tgt' }),
      headers: { 'Content-Type': 'application/json' },
    })).json()) as { id: string }
    const before = telemetryRows().length
    const res = await request(`/api/thoughts/${src.id}/link`, {
      method: 'POST',
      body: JSON.stringify({ target_id: tgt.id, type: 'develops' }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(201)
    expect(telemetryRows().length - before).toBe(1)
    expect(telemetryRows()[telemetryRows().length - 1]!.action).toBe('link')
    expect(telemetryRows()[telemetryRows().length - 1]!.tool_name).toBe('link_thoughts')
  })
})

// ── X-Client: mcp suppresses HTTP telemetry ──────────────────────────────────

describe('X-Client: mcp suppresses HTTP telemetry (no double-counting)', () => {
  test('GET /api/tags with X-Client: mcp writes zero rows', async () => {
    const headers = new Headers({ 'X-Client': 'mcp' })
    headers.set('Authorization', 'Bearer test-token')
    const res = await app.request('/api/tags', { headers })
    expect(res.status).toBe(200)
    expect(telemetryRows()).toHaveLength(0)
  })

  test('POST /api/thoughts with X-Client: mcp writes zero rows', async () => {
    const headers = new Headers({ 'X-Client': 'mcp' })
    headers.set('Authorization', 'Bearer test-token')
    const res = await app.request(new Request('http://localhost/api/thoughts', {
      method: 'POST',
      body: JSON.stringify({ content: 'mcp-suppressed' }),
      headers,
    }))
    expect(res.status).toBe(201)
    expect(telemetryRows()).toHaveLength(0)
  })

  test('GET /api/projects with X-Client: mcp writes zero rows', async () => {
    const headers = new Headers({ 'X-Client': 'mcp' })
    headers.set('Authorization', 'Bearer test-token')
    const res = await app.request('/api/projects', { headers })
    expect(res.status).toBe(200)
    expect(telemetryRows()).toHaveLength(0)
  })
})

// ── excluded routes write nothing ─────────────────────────────────────────────

describe('excluded routes (stats, settings) write zero rows', () => {
  test('GET /api/stats writes zero rows', async () => {
    const res = await request('/api/stats')
    expect(res.status).toBe(200)
    expect(telemetryRows()).toHaveLength(0)
  })

  test('GET /api/thought-settings writes zero rows', async () => {
    const res = await request('/api/thought-settings')
    expect(res.status).toBe(200)
    expect(telemetryRows()).toHaveLength(0)
  })

  test('PATCH /api/thought-settings writes zero rows', async () => {
    const res = await request('/api/thought-settings', {
      method: 'PATCH',
      body: JSON.stringify({ softLimit: 100 }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(telemetryRows()).toHaveLength(0)
  })
})
