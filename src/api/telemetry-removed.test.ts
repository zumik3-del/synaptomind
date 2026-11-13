import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../context/container'
import { closeDb } from '../db/init'
import { promoteThoughtToPrimer } from '../db/primers'
import { createTestDb, seedThought } from '../test/helpers'
import { createApp } from './router'

process.env.SYNAPTOMIND_SECRET = 'test-token'
const app = createApp()

const REMOVED_TELEMETRY_ROUTES = [
  '/api/telemetry/patterns',
  '/api/telemetry/frequency',
  '/api/telemetry/orphan_writes',
  '/api/telemetry/draft_lifecycle'
]

async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', 'Bearer test-token')
  return app.request(path, { ...init, headers })
}

beforeEach(createTestDb)
afterEach(closeDb)

function primerExists(id: string): boolean {
  const row = getDb().prepare(`SELECT COUNT(*) AS c FROM primers WHERE id = ?`).get(id) as {
    c: number
  }
  return row.c > 0
}

test('GET /api/telemetry/patterns returns 404 after the cut', async () => {
  const res = await request('/api/telemetry/patterns')
  expect(res.status).toBe(404)
})

test('GET /api/telemetry/frequency returns 404 after the cut', async () => {
  const res = await request('/api/telemetry/frequency')
  expect(res.status).toBe(404)
})

test('GET /api/telemetry/orphan_writes returns 404 after the cut', async () => {
  const res = await request('/api/telemetry/orphan_writes')
  expect(res.status).toBe(404)
})

test('GET /api/telemetry/draft_lifecycle returns 404 after the cut', async () => {
  const res = await request('/api/telemetry/draft_lifecycle')
  expect(res.status).toBe(404)
})

test('no /api/telemetry route is mounted any more', async () => {
  for (const route of REMOVED_TELEMETRY_ROUTES) {
    const res = await request(route)
    expect(res.status).toBe(404)
  }
})

test('GET /api/primers answers 404 after the HTTP shrink', async () => {
  seedThought({ content: 'http primer candidate' })
  const res = await request('/api/primers')
  expect(res.status).toBe(404)
})

test('DELETE /api/primers/:id answers 404 after the HTTP shrink', async () => {
  const thoughtId = seedThought({ content: 'http primer to delete' })
  const primer = promoteThoughtToPrimer(getDb(), thoughtId, 9)
  expect(primer).toBeDefined()

  const res = await request(`/api/primers/${primer!.id}`, { method: 'DELETE' })
  expect(res.status).toBe(404)
  expect(primerExists(primer!.id)).toBe(true)
})
