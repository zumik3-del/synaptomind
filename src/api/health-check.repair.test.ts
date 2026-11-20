import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { closeDb, getDb } from '../db'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { createApp } from './router'

const restartEmbedderMock = mock(() => {})

mock.module('../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: () => [new Float32Array(384)],
  restartEmbedder: restartEmbedderMock,
  isEmbedderReady: () => true
}))

process.env.SYNAPTOMIND_SECRET = 'test-token'
const app = createApp()

async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', 'Bearer test-token')
  return app.request(path, { ...init, headers })
}

beforeEach(createTestDb)
afterEach(closeDb)

interface HealthCheckResponse {
  summary: {
    health_score: number
    issues: { critical: number; warning: number; info: number }
  }
  categories: Array<{
    name: string
    checks: Array<{ name: string; severity: string; count: number }>
  }>
}

const INVALID_SEVERITY_BODY = {
  error: 'Invalid option: expected one of "critical"|"warning"|"info"'
}

const CATEGORY_NAMES = [
  'structural_integrity',
  'cluster_health',
  'connectivity',
  'content_quality',
  'semantic_consistency',
  'data_drift'
]

async function getReport(path: string): Promise<HealthCheckResponse> {
  const res = await request(path)
  expect(res.status).toBe(200)
  return (await res.json()) as HealthCheckResponse
}

function checkNames(report: HealthCheckResponse): string[] {
  return report.categories.flatMap(c => c.checks.map(check => check.name))
}

function seedSeverityFindings(): void {
  const selfLoop = seedThought({ content: 'A' })
  seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })
  seedThought({ content: 'hi' })
  seedEdge(selfLoop, selfLoop, 'related')
}

test('GET /api/health-check ignores ?fix=true and does not archive thoughts', async () => {
  const clusterId = seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })

  const res = await request('/api/health-check?fix=true')
  expect(res.status).toBe(200)

  const row = getDb().prepare('SELECT status FROM thoughts WHERE id = ?').get(clusterId) as {
    status: string
  }
  expect(row.status).toBe('active')
})

test('POST /api/health-check/repair previews without mutating and returns a token', async () => {
  seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })

  const res = await request('/api/health-check/repair', {
    method: 'POST',
    body: JSON.stringify({}),
    headers: { 'Content-Type': 'application/json' }
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    status: string
    preview_token?: string
    repairable?: unknown[]
  }
  expect(body.status).toBe('preview')
  expect(typeof body.preview_token).toBe('string')
})

test('POST /api/health-check/repair requires preview_token when confirm=true', async () => {
  seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })

  const res = await request('/api/health-check/repair', {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
    headers: { 'Content-Type': 'application/json' }
  })
  expect(res.status).not.toBe(200)
})

test('POST /api/health-check/repair archives (not deletes) thoughts after preview+confirm', async () => {
  const clusterId = seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })

  const previewRes = await request('/api/health-check/repair', {
    method: 'POST',
    body: JSON.stringify({}),
    headers: { 'Content-Type': 'application/json' }
  })
  expect(previewRes.status).toBe(200)
  const preview = (await previewRes.json()) as { preview_token: string }

  const execRes = await request('/api/health-check/repair', {
    method: 'POST',
    body: JSON.stringify({ confirm: true, preview_token: preview.preview_token }),
    headers: { 'Content-Type': 'application/json' }
  })
  expect(execRes.status).toBe(200)
  const exec = (await execRes.json()) as { status: string }
  expect(exec.status).toBe('executed')

  const row = getDb().prepare('SELECT status FROM thoughts WHERE id = ?').get(clusterId) as
    | { status: string }
    | undefined
  expect(row).toBeDefined()
  expect(row!.status).toBe('archived')
})

test('POST /api/health-check/repair returns 400 on missing preview_token', async () => {
  seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })

  const res = await request('/api/health-check/repair', {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
    headers: { 'Content-Type': 'application/json' }
  })
  expect(res.status).toBe(400)
})

test('POST /api/health-check/repair returns 400 on bogus preview_token', async () => {
  seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })

  const res = await request('/api/health-check/repair', {
    method: 'POST',
    body: JSON.stringify({ confirm: true, preview_token: 'bogus-token' }),
    headers: { 'Content-Type': 'application/json' }
  })
  expect(res.status).toBe(400)
})

test('POST /api/health-check/repair returns 400 on replayed preview_token', async () => {
  seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })

  const previewRes = await request('/api/health-check/repair', {
    method: 'POST',
    body: JSON.stringify({}),
    headers: { 'Content-Type': 'application/json' }
  })
  const preview = (await previewRes.json()) as { preview_token: string }

  const first = await request('/api/health-check/repair', {
    method: 'POST',
    body: JSON.stringify({ confirm: true, preview_token: preview.preview_token }),
    headers: { 'Content-Type': 'application/json' }
  })
  expect(first.status).toBe(200)

  const replay = await request('/api/health-check/repair', {
    method: 'POST',
    body: JSON.stringify({ confirm: true, preview_token: preview.preview_token }),
    headers: { 'Content-Type': 'application/json' }
  })
  expect(replay.status).toBe(400)
})

test('GET /api/health-check answers 400 with the validation body for an invalid severity', async () => {
  seedSeverityFindings()

  for (const query of ['?severity=bogus', '?severity=', '?severity']) {
    const res = await request(`/api/health-check${query}`)
    const body = await res.json()
    expect({ query, status: res.status, body }).toEqual({
      query,
      status: 400,
      body: INVALID_SEVERITY_BODY
    })
  }
})

test('GET /api/health-check refuses an invalid severity instead of returning an empty report', async () => {
  seedSeverityFindings()

  const res = await request('/api/health-check?severity=bogus')
  expect(res.status).toBe(400)
  const body = (await res.json()) as Record<string, unknown>
  expect(body).not.toHaveProperty('summary')
  expect(body).not.toHaveProperty('categories')
})

test('GET /api/health-check resolves a duplicated severity to its first value', async () => {
  seedSeverityFindings()

  const first = await getReport('/api/health-check?severity=critical&severity=bogus')
  expect(
    first.categories.flatMap(c => c.checks).every(check => check.severity === 'critical')
  ).toBe(true)
  expect(checkNames(first).length).toBeLessThan(
    checkNames(await getReport('/api/health-check')).length
  )

  const second = await request('/api/health-check?severity=bogus&severity=critical')
  expect(second.status).toBe(400)
  expect(await second.json()).toEqual(INVALID_SEVERITY_BODY)
})

test('GET /api/health-check without a severity parameter returns the full report', async () => {
  seedSeverityFindings()

  const full = await getReport('/api/health-check')
  expect(full.categories.map(c => c.name)).toEqual(CATEGORY_NAMES)
  expect(full.categories.every(c => c.checks.length > 0)).toBe(true)
  expect(full.summary.issues.info).toBeGreaterThan(0)

  const info = await getReport('/api/health-check?severity=info')
  expect(info).toEqual(full)
})

test('GET /api/health-check filters by each valid severity in the documented order', async () => {
  seedSeverityFindings()

  const full = await getReport('/api/health-check')
  const fullNames = checkNames(full)

  const critical = await getReport('/api/health-check?severity=critical')
  const criticalChecks = critical.categories.flatMap(c => c.checks)
  expect(criticalChecks.length).toBeGreaterThan(0)
  expect(criticalChecks.every(check => check.severity === 'critical')).toBe(true)
  expect(criticalChecks.length).toBeLessThan(fullNames.length)
  expect(critical.summary.issues).toEqual({ critical: 1, warning: 0, info: 0 })
  expect(critical.summary.health_score).toBe(60)

  const warning = await getReport('/api/health-check?severity=warning')
  const warningChecks = warning.categories.flatMap(c => c.checks)
  expect(warningChecks.every(check => check.severity !== 'info')).toBe(true)
  expect(warningChecks.some(check => check.severity === 'critical')).toBe(true)
  expect(warningChecks.some(check => check.severity === 'warning')).toBe(true)
  expect(warningChecks.length).toBeLessThan(fullNames.length)
  expect(warning.summary.issues).toEqual({ critical: 1, warning: 2, info: 0 })
  expect(warning.summary.health_score).toBe(45)

  expect(full.summary.health_score).toBeLessThan(critical.summary.health_score)
})

test('POST /api/health-check/repair shares the severity enum with the GET query', async () => {
  seedSeverityFindings()

  const invalid = await request('/api/health-check/repair', {
    method: 'POST',
    body: JSON.stringify({ severity: 'bogus' }),
    headers: { 'Content-Type': 'application/json' }
  })
  expect(invalid.status).toBe(400)
  expect(await invalid.json()).toEqual(INVALID_SEVERITY_BODY)

  const valid = await request('/api/health-check/repair', {
    method: 'POST',
    body: JSON.stringify({ severity: 'critical' }),
    headers: { 'Content-Type': 'application/json' }
  })
  expect(valid.status).toBe(200)
  expect(((await valid.json()) as { status: string }).status).toBe('preview')
})
