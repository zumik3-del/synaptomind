import { afterEach, beforeEach, expect, test } from 'bun:test'
import { closeDb } from '../db/init'
import { createTestDb } from '../test/helpers'
import { createApp } from './router'

// The HTTP surface is an ops plane since ADR 2026-10-26 (task #2202): 43 of the
// 46 former routes are gone with no deprecation shim, so a former route must
// answer Hono's plain 404 — not 200, not 400 (a surviving route would validate
// the body), and not a `410`/`Deprecation` shim that keeps the transport drift
// alive. This samples 29 of the 43 across every deleted router, one row per
// former capability family.
//
// Requests carry a valid bearer token on purpose: without it the `/api/*` auth
// middleware would answer 401 and the 404 would prove nothing.

process.env.SYNAPTOMIND_SECRET = 'test-token'
const app = createApp()

// A dedicated peer address keeps this file's requests out of the process-wide
// rate-limit bucket shared by every other in-process `app.request` (same trick
// as `src/middleware/rate-limit.test.ts`).
const ENV = { server: { requestIP: () => ({ address: '10.42.0.77', family: 'IPv4', port: 1234 }) } }

const THOUGHT = '01a00000-0000-7000-8000-000000000001'

interface FormerRoute {
  method: string
  path: string
  /** Router the registration lived in before the cut. */
  router: string
}

const FORMER_ROUTES: FormerRoute[] = [
  { method: 'GET', path: '/api/thoughts/search?q=anything', router: 'thoughts-search' },
  { method: 'GET', path: '/api/thoughts/timeline', router: 'thoughts' },
  { method: 'POST', path: '/api/thoughts', router: 'thoughts' },
  { method: 'POST', path: '/api/thoughts/bulk', router: 'thoughts' },
  { method: 'GET', path: `/api/thoughts/${THOUGHT}`, router: 'thoughts' },
  { method: 'PUT', path: `/api/thoughts/${THOUGHT}`, router: 'thoughts' },
  { method: 'DELETE', path: `/api/thoughts/${THOUGHT}`, router: 'thoughts' },
  { method: 'GET', path: `/api/thoughts/members/${THOUGHT}`, router: 'thoughts' },
  { method: 'POST', path: '/api/thoughts/propose', router: 'thoughts' },
  { method: 'GET', path: '/api/thoughts/links/batch?ids=x', router: 'thoughts-links' },
  { method: 'POST', path: `/api/thoughts/${THOUGHT}/links`, router: 'thoughts-links' },
  { method: 'POST', path: `/api/thoughts/${THOUGHT}/merge`, router: 'thoughts-merge' },
  { method: 'GET', path: '/api/thoughts/retention-review', router: 'retention-review' },
  { method: 'POST', path: `/api/thoughts/${THOUGHT}/retention-review/protect`, router: 'retention-review' },
  { method: 'POST', path: `/api/thoughts/${THOUGHT}/link`, router: 'links' },
  { method: 'DELETE', path: `/api/edges/${THOUGHT}`, router: 'links' },
  { method: 'GET', path: '/api/graph', router: 'graph' },
  { method: 'POST', path: '/api/cluster', router: 'cluster' },
  { method: 'GET', path: '/api/tags', router: 'tags' },
  { method: 'PUT', path: '/api/tags/tag-1', router: 'tags' },
  { method: 'GET', path: '/api/projects', router: 'projects' },
  { method: 'POST', path: '/api/projects', router: 'projects' },
  { method: 'PATCH', path: '/api/projects/project-1', router: 'projects' },
  { method: 'GET', path: '/api/primers', router: 'primers' },
  { method: 'GET', path: '/api/slots', router: 'slots' },
  { method: 'PUT', path: '/api/slots/project_context', router: 'slots' },
  { method: 'POST', path: '/api/slots/reflect', router: 'slots' },
  { method: 'GET', path: '/api/frontier', router: 'frontier' },
  { method: 'POST', path: '/api/proposals/rollback', router: 'proposals' }
]

beforeEach(createTestDb)
afterEach(closeDb)

async function call(method: string, path: string): Promise<Response> {
  return app.request(
    path,
    {
      method,
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      // A body keeps a hypothetically surviving route from failing validation
      // with 400: the only acceptable answer below is 404.
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' })
    },
    ENV
  )
}

test('the sample covers every router deleted in the cut', () => {
  const routers = new Set(FORMER_ROUTES.map(r => r.router))
  expect([...routers].sort()).toEqual([
    'cluster',
    'frontier',
    'graph',
    'links',
    'primers',
    'projects',
    'proposals',
    'retention-review',
    'slots',
    'tags',
    'thoughts',
    'thoughts-links',
    'thoughts-merge',
    'thoughts-search'
  ])
})

test('the sample is 29 former routes and none of them is a surviving endpoint', () => {
  expect(FORMER_ROUTES).toHaveLength(29)
  const survivors = ['/health', '/api/health-check', '/api/health-check/repair']
  for (const route of FORMER_ROUTES) {
    const path = route.path.split('?')[0]
    expect(survivors).not.toContain(path)
  }
})

for (const route of FORMER_ROUTES) {
  test(`${route.method} ${route.path} answers 404 (${route.router} router removed)`, async () => {
    const res = await call(route.method, route.path)
    expect(res.status).toBe(404)
    // No deprecation shim survives the cut.
    expect(res.headers.get('deprecation')).toBeNull()
    expect(res.headers.get('sunset')).toBeNull()
  })
}

test('the two surviving /api routes are still mounted behind the same middlewares', async () => {
  const unauthorized = await app.request('/api/health-check', {}, ENV)
  expect(unauthorized.status).toBe(401)

  const report = await call('GET', '/api/health-check')
  expect(report.status).toBe(200)
})
