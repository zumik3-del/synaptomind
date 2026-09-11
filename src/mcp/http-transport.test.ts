import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { request as httpRequest } from 'node:http'
import { resetValidTokens } from '../auth'
import { config } from '../config'
import {
  InMemoryEventStore,
  MAX_EVENTS_PER_SESSION,
  startMcpHttpServer,
  type McpHttpHandle
} from './http-transport'

const SECRET = 'mcp-http-test-secret'
const PROTOCOL_VERSION = '2025-06-18'
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
})

afterAll(() => {
  mainServer?.stop()
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
