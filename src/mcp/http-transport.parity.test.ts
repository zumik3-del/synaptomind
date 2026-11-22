import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { config, hashUserToken } from '../config'
import { createApp } from '../api/router'
import { closeDb } from '../db/init'
import { MAX_REQUEST_BODY_BYTES } from '../middleware/http-errors'
import { createTestDb } from '../test/helpers'
import { startMcpHttpServer, type McpHttpHandle } from './http-transport'

// Task #2602: the two HTTP surfaces mount one guarded pipeline but keep two wire shapes. This file
// drives both REAL surfaces — `createApp()` for `/api` and the bound MCP listener for `/mcp` — and
// pins where they must agree (413, 503, exact path matching) and where they must not (the error
// envelope). It binds a listener, so it lives in the integration lane (src/test/lanes.ts).

const SECRET = 'http-parity-test-secret'
const USER_TOKEN = 'http-parity-user-token'
const USER_ID = 'parity-alice'
const BODY_TOO_LARGE = 'Request body too large (max 5MB)'

const previousSecret = process.env.SYNAPTOMIND_SECRET
const previousServiceToken = process.env.SYNAPTOMIND_SERVICE_TOKEN
const previousInsecure = process.env.SYNAPTOMIND_ALLOW_INSECURE
const originalUsers = config.users

process.env.SYNAPTOMIND_SECRET = SECRET
delete process.env.SYNAPTOMIND_SERVICE_TOKEN
delete process.env.SYNAPTOMIND_ALLOW_INSECURE

interface Surface {
  name: string
  shape: 'json' | 'jsonrpc'
  request(path: string, init?: RequestInit): Response | Promise<Response>
}

const apiApp = createApp()

let mcpServer: McpHttpHandle
let mcpBase = ''

function apiSurface(): Surface {
  return {
    name: 'API (/api)',
    shape: 'json',
    request: (path, init) => apiApp.request(path, init)
  }
}

function mcpSurface(): Surface {
  return {
    name: 'MCP (/mcp)',
    shape: 'jsonrpc',
    request: (path, init) => fetch(`${mcpBase}${path}`, init)
  }
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') })
  const port = probe.port
  await probe.stop(true)
  if (port === undefined) throw new Error('Bun.serve did not report a bound port')
  return port
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

function postInit(body: string, token: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      ...bearer(token),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'content-length': String(Buffer.byteLength(body))
    },
    body
  }
}

function oversizedBody(): string {
  return JSON.stringify({ pad: 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1) })
}

// One helper, both surfaces: the status and the wire shape are the only per-surface facts.
async function expectOversizedBodyRejected(surface: Surface, path: string): Promise<void> {
  const body = oversizedBody()
  const res = await surface.request(path, postInit(body, SECRET))

  expect(res.status).toBe(413)
  expect(res.headers.get('content-type')).toContain('application/json')

  if (surface.shape === 'jsonrpc') {
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: BODY_TOO_LARGE },
      id: null
    })
    return
  }
  expect(await res.json()).toEqual({ error: BODY_TOO_LARGE })
}

beforeAll(async () => {
  const port = await freePort()
  mcpServer = startMcpHttpServer('127.0.0.1', port)
  mcpBase = `http://127.0.0.1:${port}`
})

beforeEach(createTestDb)

afterAll(async () => {
  await mcpServer?.stop()
  closeDb()
  config.users = originalUsers
  for (const [key, value] of [
    ['SYNAPTOMIND_SECRET', previousSecret],
    ['SYNAPTOMIND_SERVICE_TOKEN', previousServiceToken],
    ['SYNAPTOMIND_ALLOW_INSECURE', previousInsecure]
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('body cap parity', () => {
  test('a body above 5 MB is a 413 on both surfaces, each in its own envelope', async () => {
    await expectOversizedBodyRejected(apiSurface(), '/api/health-check')
    await expectOversizedBodyRejected(mcpSurface(), '/mcp')
  })

  test('the 413 bodies differ by design: bare JSON error vs JSON-RPC error object', async () => {
    const oversized = oversizedBody()
    const api = (await (
      await apiSurface().request('/api/health-check', postInit(oversized, SECRET))
    ).json()) as Record<string, unknown>
    const mcp = (await (
      await mcpSurface().request('/mcp', postInit(oversized, SECRET))
    ).json()) as Record<string, unknown>

    expect(api).toEqual({ error: BODY_TOO_LARGE })
    expect(mcp).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: BODY_TOO_LARGE },
      id: null
    })
    expect(api).not.toHaveProperty('jsonrpc')
    expect(mcp).not.toHaveProperty('error', BODY_TOO_LARGE)
  })
})

describe('database-unavailable parity', () => {
  test('a configured user without a database answers the identical 503 on both surfaces', async () => {
    config.users = [
      {
        id: USER_ID,
        dbPath: '/tmp/opencode/t2602-absent.db',
        tokenSha256: hashUserToken(USER_TOKEN)
      }
    ]
    try {
      const [apiRes, mcpRes] = await Promise.all([
        apiSurface().request('/api/health-check', { headers: bearer(USER_TOKEN) }),
        mcpSurface().request('/mcp', { headers: bearer(USER_TOKEN) })
      ])

      expect(apiRes.status).toBe(503)
      expect(mcpRes.status).toBe(503)
      expect(apiRes.headers.get('content-type')).toContain('application/json')
      expect(mcpRes.headers.get('content-type')).toContain('application/json')

      const apiText = await apiRes.text()
      const mcpText = await mcpRes.text()
      expect(mcpText).toBe(apiText)
      expect(JSON.parse(mcpText)).toEqual({ error: 'Database unavailable' })
      // The 503 comes from the shared user-context middleware, so it is deliberately NOT
      // shape-differentiated: an MCP client sees the same bare JSON error as an /api caller.
      expect(JSON.parse(mcpText)).not.toHaveProperty('jsonrpc')
    } finally {
      config.users = []
    }
  })
})

describe('exact path matching', () => {
  test('/api/health-check/ answers 404 while /api/health-check is mounted', async () => {
    const slashed = await apiSurface().request('/api/health-check/', {
      headers: bearer(SECRET)
    })
    expect(slashed.status).toBe(404)
    expect(slashed.headers.get('content-type')).toContain('text/plain')
    expect(await slashed.text()).toBe('404 Not Found')

    const mounted = await apiSurface().request('/api/health-check', { headers: bearer(SECRET) })
    expect(mounted.status).toBe(200)
  })

  test('/mcp/ answers 404 while /mcp is mounted', async () => {
    const slashed = await mcpSurface().request('/mcp/', { headers: bearer(SECRET) })
    expect(slashed.status).toBe(404)
    expect(slashed.headers.get('content-type')).toContain('text/plain')
    expect(await slashed.text()).toBe('404 Not Found')
    expect(slashed.headers.get('mcp-session-id')).toBeNull()

    // The mounted path is reached: a non-initialize request is a protocol error, not a 404.
    const mounted = await mcpSurface().request('/mcp', {
      method: 'POST',
      headers: {
        ...bearer(SECRET),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    })
    expect(mounted.status).toBe(400)
    await mounted.body?.cancel()
  })

  test('docs/API.md states the exact-path rule for both listeners', () => {
    const doc = readFileSync(new URL('../../docs/API.md', import.meta.url), 'utf8')
    const flat = doc.replace(/\s+/g, ' ')

    expect(flat).toContain('`/api/health-check/` answers `404`')
    expect(flat).toContain('`/mcp/` is `404`')
  })
})

describe('surface wiring', () => {
  test('both surfaces reach the shared pipeline: no token is 401 with the same body', async () => {
    const [apiRes, mcpRes] = await Promise.all([
      apiSurface().request('/api/health-check'),
      mcpSurface().request('/mcp')
    ])

    expect(apiRes.status).toBe(401)
    expect(mcpRes.status).toBe(401)
    const apiText = await apiRes.text()
    expect(await mcpRes.text()).toBe(apiText)
    expect(JSON.parse(apiText)).toEqual({ error: 'Unauthorized' })
  })

  test('the MCP server is still listening (the parity fixtures are live)', () => {
    expect(mcpServer.getSessions()).toBeDefined()
  })
})
