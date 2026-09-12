import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { request as httpRequest } from 'node:http'
import { Hono } from 'hono'
import { resetValidTokens } from '../auth'
import { config } from '../config'
import {
  InMemoryEventStore,
  MAX_EVENTS_PER_SESSION,
  MAX_REQUEST_BODY_BYTES,
  mcpErrorHandler,
  startMcpHttpServer,
  type McpHttpHandle
} from './http-transport'

const SECRET = 'mcp-http-test-secret'
const PROTOCOL_VERSION = '2025-06-18'
const ALLOWED_ORIGIN = 'https://app.synaptomind.example'
const DENIED_ORIGIN = 'https://evil.example'
const INIT_MESSAGE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'http-transport-test', version: '1.0.0' }
  }
}
const LIST_MESSAGE = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }

let mainServer: McpHttpHandle
let mainBase: string
let mainPort: number

// A second server with a non-empty CORS allow-list, so allow/deny behaviour can
// be asserted against both configurations.
let corsServer: McpHttpHandle
let corsBase: string

let previousSecret: string | undefined
let previousServiceToken: string | undefined
let previousInsecure: string | undefined

// Bind an ephemeral port, read it, release it, and hand it to the server under
// test. startMcpHttpServer does not expose the bound port, so it must be known
// up-front.
async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') })
  const port = probe.port
  await probe.stop(true)
  if (port === undefined) throw new Error('Bun.serve did not report a bound port')
  return port
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${SECRET}`, ...extra }
}

function rpc(base: string, body: unknown, sessionId?: string): Promise<Response> {
  const headers = authHeaders({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(sessionId ? { 'mcp-session-id': sessionId } : {})
  })
  return fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
}

async function initialize(base: string): Promise<string> {
  const res = await rpc(base, INIT_MESSAGE)
  const id = res.headers.get('mcp-session-id')
  await res.body?.cancel()
  if (!id) throw new Error(`initialize did not issue a session id (status ${res.status})`)
  return id
}

function destroy(base: string, sessionId: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'DELETE',
    headers: authHeaders({ 'mcp-session-id': sessionId })
  })
}

// The rate-limit bucket is keyed by the client socket address. fetch always
// connects from 127.0.0.1 (shared with the session tests above), so drive the
// limiter with a node client bound to a distinct loopback source address.
function rpcFromLocalAddress(body: unknown, sessionId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: mainPort,
        path: '/mcp',
        method: 'POST',
        localAddress: '127.0.0.2',
        headers: authHeaders({
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
          'content-length': String(Buffer.byteLength(payload))
        })
      },
      res => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end(payload)
  })
}

beforeAll(async () => {
  previousSecret = process.env.SYNAPTOMIND_SECRET
  previousServiceToken = process.env.SYNAPTOMIND_SERVICE_TOKEN
  previousInsecure = process.env.SYNAPTOMIND_ALLOW_INSECURE
  process.env.SYNAPTOMIND_SECRET = SECRET
  delete process.env.SYNAPTOMIND_SERVICE_TOKEN
  delete process.env.SYNAPTOMIND_ALLOW_INSECURE
  resetValidTokens()

  mainPort = await freePort()
  mainServer = startMcpHttpServer('127.0.0.1', mainPort)
  mainBase = `http://127.0.0.1:${mainPort}`

  const corsPort = await freePort()
  corsServer = startMcpHttpServer('127.0.0.1', corsPort, { corsOrigins: [ALLOWED_ORIGIN] })
  corsBase = `http://127.0.0.1:${corsPort}`
})

afterAll(async () => {
  await corsServer?.stop()
  await mainServer?.stop()
  if (previousSecret === undefined) delete process.env.SYNAPTOMIND_SECRET
  else process.env.SYNAPTOMIND_SECRET = previousSecret
  if (previousServiceToken === undefined) delete process.env.SYNAPTOMIND_SERVICE_TOKEN
  else process.env.SYNAPTOMIND_SERVICE_TOKEN = previousServiceToken
  if (previousInsecure === undefined) delete process.env.SYNAPTOMIND_ALLOW_INSECURE
  else process.env.SYNAPTOMIND_ALLOW_INSECURE = previousInsecure
  resetValidTokens()
})

describe('HTTP auth boundary', () => {
  test('missing Authorization header is rejected with 401', async () => {
    const res = await fetch(`${mainBase}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(INIT_MESSAGE)
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  test('invalid bearer token is rejected with 401', async () => {
    const res = await fetch(`${mainBase}/mcp`, {
      method: 'POST',
      headers: authHeaders({
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer not-the-secret'
      }),
      body: JSON.stringify(INIT_MESSAGE)
    })
    expect(res.status).toBe(401)
  })

  test('/health stays unauthenticated and exposes only liveness', async () => {
    const res = await fetch(`${mainBase}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})

describe('HTTP session lifecycle', () => {
  test('initialize issues a session id, follow-up on the same session succeeds', async () => {
    const before = mainServer.getSessions().size
    const res = await rpc(mainBase, INIT_MESSAGE)
    expect(res.status).toBe(200)
    const sessionId = res.headers.get('mcp-session-id')
    expect(sessionId).toBeString()
    await res.body?.cancel()
    expect(mainServer.getSessions().size).toBe(before + 1)
    expect(mainServer.getSessions().has(sessionId!)).toBe(true)

    const followUp = await rpc(mainBase, LIST_MESSAGE, sessionId!)
    expect(followUp.status).toBe(200)
    expect(followUp.headers.get('mcp-session-id')).toBe(sessionId)
    await followUp.body?.cancel()

    const closed = await destroy(mainBase, sessionId!)
    expect(closed.status).toBe(200)
  })

  test('unknown mcp-session-id returns 404', async () => {
    const res = await rpc(mainBase, LIST_MESSAGE, 'no-such-session')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: number; message: string } }
    expect(body.error.code).toBe(-32001)
    expect(body.error.message).toBe('Session not found')
  })

  test('a session dropped from the store (expired) returns 404', async () => {
    const sessionId = await initialize(mainBase)
    // What the TTL sweeper does once SESSION_TTL_MS has elapsed.
    mainServer.getSessions().delete(sessionId)

    const res = await rpc(mainBase, LIST_MESSAGE, sessionId)
    expect(res.status).toBe(404)
    await res.body?.cancel()
  })

  test('DELETE closes the session and the id can no longer be used', async () => {
    const sessionId = await initialize(mainBase)
    expect(mainServer.getSessions().has(sessionId)).toBe(true)

    const closed = await destroy(mainBase, sessionId)
    expect(closed.status).toBe(200)
    expect(mainServer.getSessions().has(sessionId)).toBe(false)

    const reuse = await rpc(mainBase, LIST_MESSAGE, sessionId)
    expect(reuse.status).toBe(404)
    await reuse.body?.cancel()
  })

  test('a non-initialize request without a session id leaks no session', async () => {
    const before = mainServer.getSessions().size

    const res = await rpc(mainBase, LIST_MESSAGE)

    expect(res.status).toBe(400)
    await res.body?.cancel()
    expect(mainServer.getSessions().size).toBe(before)
  })
})

describe('InMemoryEventStore replay', () => {
  test('replays events after the given id in insertion order, same stream only', async () => {
    const store = new InMemoryEventStore()
    const streamA = 'stream-a'
    const streamB = 'stream-b'
    const a1 = await store.storeEvent(streamA, { n: 1 })
    const a2 = await store.storeEvent(streamA, { n: 2 })
    const a3 = await store.storeEvent(streamA, { n: 3 })
    await store.storeEvent(streamB, { n: 'b1' })
    const a4 = await store.storeEvent(streamA, { n: 4 })

    const sent: Array<{ id: string; message: unknown }> = []
    const streamId = await store.replayEventsAfter(a2, {
      send: async (id, message) => {
        sent.push({ id, message })
      }
    })

    expect(streamId).toBe(streamA)
    expect(sent.map(s => s.id)).toEqual([a3, a4])
    expect(sent.map(s => s.message)).toEqual([{ n: 3 }, { n: 4 }])
    expect(sent.some(s => s.id === a1)).toBe(false)
  })

  test('replaying after an unknown id yields no events and an empty stream id', async () => {
    const store = new InMemoryEventStore()
    await store.storeEvent('stream-a', { n: 1 })

    const sent: string[] = []
    const streamId = await store.replayEventsAfter('missing-id', {
      send: async id => {
        sent.push(id)
      }
    })

    expect(streamId).toBe('')
    expect(sent).toEqual([])
  })

  test(`caps stored events at MAX_EVENTS_PER_SESSION (${MAX_EVENTS_PER_SESSION})`, async () => {
    const store = new InMemoryEventStore()
    const first = await store.storeEvent('stream-a', { n: -1 })
    for (let i = 0; i < MAX_EVENTS_PER_SESSION; i++) {
      await store.storeEvent('stream-a', { n: i })
    }

    // The oldest event was evicted, so resume from it is a no-op.
    const sent: string[] = []
    const streamId = await store.replayEventsAfter(first, {
      send: async id => {
        sent.push(id)
      }
    })
    expect(streamId).toBe('')
    expect(sent).toEqual([])
  })

  // F10: losing the replay anchor must be observable, while an id that was
  // never stored (client bug) must stay silent.
  test('a known-but-evicted replay anchor signals onReplayAnchorEvicted; an unknown id does not', async () => {
    const signalled: string[] = []
    const store = new InMemoryEventStore({ onReplayAnchorEvicted: id => signalled.push(id) })
    const first = await store.storeEvent('stream-a', { n: -1 })
    for (let i = 0; i < MAX_EVENTS_PER_SESSION; i++) {
      await store.storeEvent('stream-a', { n: i })
    }

    const anchorStream = await store.replayEventsAfter(first, { send: async () => {} })
    expect(anchorStream).toBe('')
    expect(signalled).toEqual([first])

    // An id that was never stored is not a resumability loss.
    const unknownStream = await store.replayEventsAfter('never-stored-id', { send: async () => {} })
    expect(unknownStream).toBe('')
    expect(signalled).toEqual([first])
  })
})

describe('HTTP rate limiting', () => {
  test('the request after the configured limit is rejected with 429', async () => {
    const max = config.rateLimit.max
    expect(max).toBeGreaterThan(0)

    const allowed: number[] = []
    for (let i = 0; i < max; i++) {
      allowed.push(await rpcFromLocalAddress(LIST_MESSAGE, 'bogus-session'))
    }

    expect(allowed.every(status => status !== 429)).toBe(true)
    const blocked = await rpcFromLocalAddress(LIST_MESSAGE, 'bogus-session')
    expect(blocked).toBe(429)
  })
})

// Coverage for task #167 (F5/F6/F7): the MCP HTTP endpoint must reject oversized
// bodies, answer with a JSON-RPC error envelope on unhandled failures, and never
// combine a wildcard CORS origin with bearer auth.
describe('HTTP body cap', () => {
  test('rejects an oversized /mcp body with a JSON-RPC 413 and creates no session', async () => {
    const before = mainServer.getSessions().size
    const oversized = JSON.stringify({
      ...INIT_MESSAGE,
      // Push the Content-Length one byte past the cap; the guard must fire
      // before the initialize body is ever parsed.
      pad: 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1)
    })

    const res = await fetch(`${mainBase}/mcp`, {
      method: 'POST',
      headers: authHeaders({
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      }),
      body: oversized
    })

    expect(res.status).toBe(413)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('mcp-session-id')).toBeNull()
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Request body too large (max 5MB)' },
      id: null
    })
    // No partial processing: the capped request must not register a session.
    expect(mainServer.getSessions().size).toBe(before)
  })
})

describe('HTTP error envelope', () => {
  test('mcpErrorHandler returns JSON-RPC -32603/500 instead of Hono default text', async () => {
    const app = new Hono()
    app.onError(mcpErrorHandler)
    app.get('/boom', () => {
      throw new Error('boom')
    })

    const res = await app.request('/boom')

    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal error' },
      id: null
    })
  })

  test('the running server routes an unhandled middleware throw to the JSON-RPC envelope', async () => {
    // A throwing CORS origin resolver is a probe for the onError wiring: the
    // real Hono app must catch the throw and answer with the registered handler
    // rather than Hono's plain-text default. Start on an ephemeral port because
    // the handler is only reachable through a served request.
    const port = await freePort()
    const failingServer = startMcpHttpServer('127.0.0.1', port, {
      corsOrigins: (() => {
        throw new Error('forced failure')
      }) as unknown as string[]
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { origin: ALLOWED_ORIGIN }
      })
      expect(res.status).toBe(500)
      expect(res.headers.get('content-type')).toContain('application/json')
      expect(await res.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
        id: null
      })
    } finally {
      await failingServer.stop()
    }
  })
})

describe('CORS policy', () => {
  test('deny-all default emits no Access-Control-Allow-Origin (and never a wildcard)', async () => {
    const res = await fetch(`${mainBase}/health`, { headers: { origin: ALLOWED_ORIGIN } })

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*')
  })

  test('allow-list echoes the configured origin and denies everything else', async () => {
    const allowed = await fetch(`${corsBase}/health`, { headers: { origin: ALLOWED_ORIGIN } })
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN)

    const denied = await fetch(`${corsBase}/health`, { headers: { origin: DENIED_ORIGIN } })
    expect(denied.status).toBe(200)
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('preflight OPTIONS is answered per origin: allowed echoed, denied omitted', async () => {
    const preflight = (origin: string) =>
      fetch(`${corsBase}/mcp`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type'
        }
      })

    const allowed = await preflight(ALLOWED_ORIGIN)
    expect(allowed.status).toBe(204)
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN)
    expect(allowed.headers.get('access-control-allow-methods')).toContain('POST')

    const denied = await preflight(DENIED_ORIGIN)
    expect(denied.status).toBe(204)
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('SYNAPTOMIND_MCP_CORS_ORIGINS parsing', () => {
  test('parses, trims, and drops empty comma-separated entries', async () => {
    const key = 'SYNAPTOMIND_MCP_CORS_ORIGINS'
    const previous = process.env[key]
    process.env[key] = ' https://a.example , https://b.example ,'
    try {
      // The config singleton is built at import time from process.env, so a
      // cache-busting query specifier is required to observe the override.
      const mod = await import(`../config.ts?cors-probe=${Date.now()}`)
      expect(mod.config.mcp.corsOrigins).toEqual(['https://a.example', 'https://b.example'])
    } finally {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  })
})
