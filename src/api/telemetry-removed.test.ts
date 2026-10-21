import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../db/container'
import { closeDb } from '../db/init'
import { promoteThoughtToPrimer } from '../db/primers'
import { createTestDb, seedThought } from '../test/helpers'
import { createApp } from './router'

// Coverage for the telemetry cut (ADR 2026-10-21, Q1/Q6): the four
// `GET /api/telemetry/*` routes are gone, so they answer 404 — a clean removal,
// no deprecation shim. The HTTP primer surface that survived the cut
// (`GET /api/primers`, `DELETE /api/primers/:id`) must keep working: the
// removal touched its `withTelemetry` wrapper, not its behaviour.

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

/** Whether a primer row is still in the main db (raw SQL, no cut-only symbol). */
function primerExists(id: string): boolean {
  const row = getDb().prepare(`SELECT COUNT(*) AS c FROM primers WHERE id = ?`).get(id) as { c: number }
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

// ── the surviving HTTP primer surface ────────────────────────────────────────

test('GET /api/primers still lists the primer set', async () => {
  const thoughtId = seedThought({ content: 'http primer candidate' })
  const primer = promoteThoughtToPrimer(getDb(), thoughtId, 9)
  expect(primer).toBeDefined()

  // The mounted path is `/api/primers` (Hono merges the sub-app's `/` handler
  // onto the mount prefix); the trailing-slash form has always 404'd.
  const res = await request('/api/primers')
  expect(res.status).toBe(200)
  const body = (await res.json()) as Array<{ id: string; thought_id: string }>
  expect(body.map(p => p.thought_id)).toContain(thoughtId)
})

test('DELETE /api/primers/:id still deletes immediately', async () => {
  const thoughtId = seedThought({ content: 'http primer to delete' })
  const primer = promoteThoughtToPrimer(getDb(), thoughtId, 9)
  expect(primer).toBeDefined()

  const res = await request(`/api/primers/${primer!.id}`, { method: 'DELETE' })
  expect(res.status).toBe(200)
  expect((await res.json()) as Record<string, unknown>).toMatchObject({ success: true })
  expect(primerExists(primer!.id)).toBe(false)
})

test('DELETE /api/primers/:id answers 404 for an unknown id', async () => {
  const res = await request('/api/primers/no-such-primer', { method: 'DELETE' })
  expect(res.status).toBe(404)
})
