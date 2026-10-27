import { afterEach, beforeEach, expect, test } from 'bun:test'
import { closeDb } from '../db/init'
import { createTestDb } from '../test/helpers'
import { createApp } from './router'

// The public liveness probe (ADR 2026-10-26): `/health` is the one route the
// deploy updater, the Docker healthcheck and CI poll. It must stay public
// (no bearer token), report the version, and answer 503 when the database check
// fails. Moved here from the deleted `routes.test.ts` when the HTTP surface
// shrank to the ops endpoints.

process.env.SYNAPTOMIND_SECRET = 'test-token'
const app = createApp()

beforeEach(createTestDb)
afterEach(closeDb)

test('GET /health answers without any Authorization header (stays public)', async () => {
  const res = await app.request('/health')
  expect(res.status).toBe(200)
})

test('GET /health returns ok with a healthy database', async () => {
  const res = await app.request('/health')
  expect(res.status).toBe(200)
  const body = (await res.json()) as Record<string, unknown>
  expect(body.status).toBe('ok')
  const checks = body.checks as Record<string, unknown>
  expect(checks.database).toBe('ok')
  expect(['ok', 'not ready', 'failed']).toContain(String(checks.embedder))
})

test('GET /health returns 503 degraded when the database check fails (issue #107)', async () => {
  // Fresh DB per test, so closing it here is the only state change needed.
  closeDb()

  const res = await app.request('/health')
  expect(res.status).toBe(503)
  const body = (await res.json()) as Record<string, unknown>
  expect(body.status).toBe('degraded')
  const checks = body.checks as Record<string, unknown>
  expect(checks.database).toBeTruthy()
  expect(checks.database).not.toBe('ok')
})

test('GET /health returns the package version', async () => {
  const res = await app.request('/health')
  const body = (await res.json()) as Record<string, unknown>
  expect(body.version).toBeString()
  expect(body.version).toMatch(/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/)
})

test('the /api ops routes still require the bearer token, unlike /health', async () => {
  const res = await app.request('/api/health-check')
  expect(res.status).toBe(401)
  expect((await res.json()) as Record<string, unknown>).toEqual({ error: 'Unauthorized' })
})
