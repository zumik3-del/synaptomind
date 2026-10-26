import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { closeDb } from '../db/init'
import { createTestDb } from '../test/helpers'
import { createApp } from './router'

// The HTTP surface is an ops plane since ADR 2026-10-26 (task #2202): 43 of the
// 46 former routes are gone with no deprecation shim, so a former route must
// answer Hono's plain 404 — not 200, not 400 (a surviving route would validate
// the body), and not a `410`/`Deprecation` shim that keeps the transport drift
// alive. This pins all 43, one row per route, in the order of the contract
// table in docs/API.md#removed-routes-020 (task #2212 closes the 14-route gap a
// sample left behind).
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

/**
 * Paths are the documented templates, not concrete URLs, so this ledger can be
 * diffed against the docs table one-to-one; `PARAMS` materialises them for the
 * actual request.
 */
const FORMER_ROUTES: FormerRoute[] = [
  { method: 'GET', path: '/api/thoughts/search', router: 'thoughts-search' },
  { method: 'GET', path: '/api/thoughts/timeline', router: 'thoughts' },
  { method: 'POST', path: '/api/thoughts', router: 'thoughts' },
  { method: 'POST', path: '/api/thoughts/bulk', router: 'thoughts' },
  { method: 'GET', path: '/api/thoughts/:id', router: 'thoughts' },
  { method: 'PUT', path: '/api/thoughts/:id', router: 'thoughts' },
  { method: 'DELETE', path: '/api/thoughts/:id', router: 'thoughts' },
  { method: 'GET', path: '/api/thoughts/:id/edges', router: 'thoughts' },
  { method: 'GET', path: '/api/thoughts/members/:id', router: 'thoughts' },
  { method: 'POST', path: '/api/thoughts/propose', router: 'thoughts' },
  { method: 'POST', path: '/api/thoughts/:targetId/merge', router: 'thoughts-merge' },
  { method: 'GET', path: '/api/thoughts/retention-review', router: 'retention-review' },
  { method: 'POST', path: '/api/thoughts/retention-review/compact', router: 'retention-review' },
  { method: 'POST', path: '/api/thoughts/:id/retention-review/protect', router: 'retention-review' },
  { method: 'POST', path: '/api/thoughts/:id/retention-review/delete', router: 'retention-review' },
  { method: 'GET', path: '/api/thoughts/:id/links', router: 'thoughts-links' },
  { method: 'GET', path: '/api/thoughts/links/batch', router: 'thoughts-links' },
  { method: 'POST', path: '/api/thoughts/:id/links', router: 'thoughts-links' },
  { method: 'DELETE', path: '/api/thoughts/:id/links/:key', router: 'thoughts-links' },
  { method: 'GET', path: '/api/tags', router: 'tags' },
  { method: 'PUT', path: '/api/tags/:id', router: 'tags' },
  { method: 'DELETE', path: '/api/tags/:id', router: 'tags' },
  { method: 'POST', path: '/api/thoughts/:id/link', router: 'links' },
  { method: 'DELETE', path: '/api/edges/:id', router: 'links' },
  { method: 'GET', path: '/api/graph', router: 'graph' },
  { method: 'POST', path: '/api/cluster', router: 'cluster' },
  { method: 'GET', path: '/api/proposals', router: 'proposals' },
  { method: 'POST', path: '/api/proposals', router: 'proposals' },
  { method: 'POST', path: '/api/proposals/:id/apply', router: 'proposals' },
  { method: 'POST', path: '/api/proposals/rollback', router: 'proposals' },
  { method: 'POST', path: '/api/proposals/:id/reject', router: 'proposals' },
  { method: 'GET', path: '/api/projects', router: 'projects' },
  { method: 'GET', path: '/api/projects/resolve', router: 'projects' },
  { method: 'POST', path: '/api/projects', router: 'projects' },
  { method: 'PATCH', path: '/api/projects/:id', router: 'projects' },
  { method: 'GET', path: '/api/projects/:id', router: 'projects' },
  { method: 'DELETE', path: '/api/projects/:id', router: 'projects' },
  { method: 'GET', path: '/api/primers', router: 'primers' },
  { method: 'DELETE', path: '/api/primers/:id', router: 'primers' },
  { method: 'GET', path: '/api/slots', router: 'slots' },
  { method: 'PUT', path: '/api/slots/:name', router: 'slots' },
  { method: 'POST', path: '/api/slots/reflect', router: 'slots' },
  { method: 'GET', path: '/api/frontier', router: 'frontier' }
]

const PARAMS: Record<string, string> = {
  ':id': THOUGHT,
  ':targetId': THOUGHT,
  ':key': 'k1',
  ':name': 'project_context'
}

function materialise(path: string): string {
  return path.replace(/:[A-Za-z]+/g, param => {
    const value = PARAMS[param]
    if (!value) throw new Error(`no concrete value for ${param} in ${path}`)
    return value
  })
}

/**
 * The removed-route table in docs/API.md is the published contract; this file is
 * its executable copy. Reading it here means a route added to or dropped from
 * the documentation cannot silently escape the 404 pin (the gap this task
 * closed: 29 of 43 rows were sampled).
 */
function documentedFormerRoutes(): string[] {
  const doc = readFileSync(new URL('../../docs/API.md', import.meta.url), 'utf8')
  const start = doc.indexOf('## Removed routes (0.20)')
  const end = doc.indexOf('## Dropped capabilities')
  if (start < 0 || end < start) throw new Error('docs/API.md: removed-routes table not found')
  return doc
    .slice(start, end)
    .split('\n')
    .map(line => /^\|\s*`(GET|POST|PUT|PATCH|DELETE)`\s*\|\s*`([^`]+)`/.exec(line))
    .filter(match => match !== null)
    .map(match => `${match[1]} ${match[2]}`)
}

const label = (route: FormerRoute): string => `${route.method} ${route.path}`

beforeEach(createTestDb)
afterEach(closeDb)

async function call(method: string, path: string): Promise<Response> {
  return app.request(
    materialise(path),
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

test('the ledger matches the removed-route table in docs/API.md exactly', () => {
  expect(FORMER_ROUTES.map(label).sort()).toEqual(documentedFormerRoutes().sort())
})

test('the ledger covers every router deleted in the cut', () => {
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

test('the ledger is 43 distinct former routes and none of them is a surviving endpoint', () => {
  expect(FORMER_ROUTES).toHaveLength(43)
  // A duplicate row would pad the count without proving another route.
  expect(new Set(FORMER_ROUTES.map(label)).size).toBe(FORMER_ROUTES.length)
  const survivors = ['/health', '/api/health-check', '/api/health-check/repair']
  for (const route of FORMER_ROUTES) {
    expect(survivors).not.toContain(route.path)
  }
})

test('every path placeholder has a concrete value', () => {
  for (const route of FORMER_ROUTES) {
    expect(materialise(route.path)).not.toContain(':')
  }
})

for (const route of FORMER_ROUTES) {
  test(`${label(route)} answers plain 404 (${route.router} router removed)`, async () => {
    const res = await call(route.method, route.path)
    expect(res.status).toBe(404)
    // The status alone would not prove removal: a surviving `:id` route answers
    // its own 404 envelope (`application/json`, `{"error":"Not found"}`) for an
    // unknown id. Only Hono's default — `text/plain`, `404 Not Found` — means
    // there is no route at all.
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(await res.text()).toBe('404 Not Found')
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
