import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { config } from '../config'
import { createGuardedPipeline } from './guarded-pipeline'
import { configFixture } from '../test/helpers'
import { MAX_REQUEST_BODY_BYTES, type ErrorShape } from './http-errors'

// Task #2602: the one guarded pipeline both HTTP surfaces mount. `shape` only picks the error
// envelope, so every case below runs against the same middleware list twice — `/api` (JSON) and
// `/mcp` (JSON-RPC) — and the two envelopes are pinned as different on purpose.

const SECRET = 'guarded-pipeline-test-secret'
const BODY_TOO_LARGE = 'Request body too large (max 5MB)'
const TOO_LARGE_BODY = JSON.stringify({ pad: 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1) })

const previousSecret = process.env.SYNAPTOMIND_SECRET
const previousServiceToken = process.env.SYNAPTOMIND_SERVICE_TOKEN
const previousInsecure = process.env.SYNAPTOMIND_ALLOW_INSECURE
const singleUser = configFixture({ users: [] })

beforeAll(() => {
  process.env.SYNAPTOMIND_SECRET = SECRET
  delete process.env.SYNAPTOMIND_SERVICE_TOKEN
  delete process.env.SYNAPTOMIND_ALLOW_INSECURE
})

afterAll(() => {
  for (const [key, value] of [
    ['SYNAPTOMIND_SECRET', previousSecret],
    ['SYNAPTOMIND_SERVICE_TOKEN', previousServiceToken],
    ['SYNAPTOMIND_ALLOW_INSECURE', previousInsecure]
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const SURFACE_KINDS: ReadonlyArray<{ name: string; shape: ErrorShape }> = [
  { name: 'API surface (JSON envelope)', shape: 'json' },
  { name: 'MCP surface (JSON-RPC envelope)', shape: 'jsonrpc' }
]

// One pipeline instance per surface, mounted exactly the way the surface mounts it.
function surfaceApp(shape: ErrorShape): Hono {
  const app = new Hono()
  for (const guard of createGuardedPipeline({ shape, config: singleUser })) app.use('/probe', guard)
  app.get('/probe', c => c.text('ok'))
  app.post('/probe', c => c.text('reached'))
  return app
}

// `app.request` in-process has no socket, so `getConnInfo` throws and the limiter keys on
// 'unknown'; hand it a fake server to make the peer address explicit (same trick as
// rate-limit.test.ts).
function envFor(ip: string): {
  server: { requestIP: () => { address: string; family: string; port: number } }
} {
  return { server: { requestIP: () => ({ address: ip, family: 'IPv4', port: 1234 }) } }
}

function post(
  app: Hono,
  body: string,
  authorized = true,
  length = body.length
): Response | Promise<Response> {
  return app.request('/probe', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(length),
      ...(authorized ? { authorization: `Bearer ${SECRET}` } : {})
    },
    body
  })
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${SECRET}` }
}

async function expectBodyCapEnvelope(res: Response, shape: ErrorShape): Promise<void> {
  expect(res.status).toBe(413)
  expect(res.headers.get('content-type')).toContain('application/json')
  if (shape === 'jsonrpc') {
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: BODY_TOO_LARGE },
      id: null
    })
    return
  }
  expect(await res.json()).toEqual({ error: BODY_TOO_LARGE })
}

describe('guarded pipeline — body cap', () => {
  for (const surface of SURFACE_KINDS) {
    test(`${surface.name}: a body above 5 MB answers 413 in its own envelope`, async () => {
      await expectBodyCapEnvelope(
        await post(surfaceApp(surface.shape), TOO_LARGE_BODY),
        surface.shape
      )
    })
  }

  test('the two 413 envelopes are JSON vs JSON-RPC on purpose', async () => {
    const json = (await (await post(surfaceApp('json'), TOO_LARGE_BODY)).json()) as Record<
      string,
      unknown
    >
    const rpc = (await (await post(surfaceApp('jsonrpc'), TOO_LARGE_BODY)).json()) as Record<
      string,
      unknown
    >

    expect(json).not.toHaveProperty('jsonrpc')
    expect(typeof json.error).toBe('string')
    expect(rpc.jsonrpc).toBe('2.0')
    expect(rpc.id).toBeNull()
    expect(typeof rpc.error).toBe('object')
  })

  test('a body of exactly the limit still reaches the handler (the cap is strict >)', async () => {
    const body = 'x'.repeat(MAX_REQUEST_BODY_BYTES)
    const res = await post(surfaceApp('json'), body, true, MAX_REQUEST_BODY_BYTES)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('reached')
  })

  test('auth runs before the body cap: an oversized unauthenticated request answers 401', async () => {
    for (const surface of SURFACE_KINDS) {
      const res = await post(surfaceApp(surface.shape), TOO_LARGE_BODY, false)
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Unauthorized' })
    }
  })
})

describe('guarded pipeline — per-surface rate-limit stores', () => {
  const MAX = config.rateLimit.max

  async function burst(app: Hono, ip: string): Promise<void> {
    const env = envFor(ip)
    for (let i = 0; i < MAX; i++) {
      const res = await app.request('/probe', { headers: authHeaders() }, env)
      if (res.status !== 200) throw new Error(`burst request ${i + 1} of ${MAX}: ${res.status}`)
    }
    const blocked = await app.request('/probe', { headers: authHeaders() }, env)
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toEqual({ error: 'Rate limit exceeded' })
  }

  test('a burst on the API surface leaves the MCP surface untouched (same client address)', async () => {
    const api = surfaceApp('json')
    const mcp = surfaceApp('jsonrpc')
    const ip = '198.18.7.1'

    await burst(api, ip)

    const allowed = await mcp.request('/probe', { headers: authHeaders() }, envFor(ip))
    expect(allowed.status).toBe(200)
    expect(await allowed.text()).toBe('ok')
  })

  test('a burst on the MCP surface leaves the API surface untouched (same client address)', async () => {
    const api = surfaceApp('json')
    const mcp = surfaceApp('jsonrpc')
    const ip = '198.18.7.2'

    await burst(mcp, ip)

    const allowed = await api.request('/probe', { headers: authHeaders() }, envFor(ip))
    expect(allowed.status).toBe(200)
    expect(await allowed.text()).toBe('ok')
  })

  test('each surface gets its own four-stage pipeline, including a fresh rate-limit store', () => {
    const api = createGuardedPipeline({ shape: 'json' })
    const mcp = createGuardedPipeline({ shape: 'jsonrpc' })

    // auth → user context → rate limit → body cap, one instance per surface.
    expect(api).toHaveLength(4)
    expect(mcp).toHaveLength(4)
    expect(api[0]).toBe(mcp[0])
    expect(api[2]).not.toBe(mcp[2])
  })
})
