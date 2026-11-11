import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createTestDb } from '../test/helpers'
import { startMcpHttpServer, type McpHttpHandle } from './http-transport'

// Dual-era routing (ADR 2026-11-11, task #2434): the modern 2026-07-28 leg is
// entered by the SDK's own predicate, the legacy sessionful leg is unchanged,
// and the negative ladder belongs to the modern path. Every case below drives a
// real listener on an ephemeral port.
const SECRET = 'mcp-modern-test-secret'
const MODERN = '2026-07-28'
const LEGACY = '2025-06-18'
const ALLOWED_ORIGIN = 'https://app.synaptomind.example'
const DENIED_ORIGIN = 'https://evil.example'

const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientCapabilities': {}
}

const INIT_MESSAGE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: LEGACY,
    capabilities: {},
    clientInfo: { name: 'modern-transport-test', version: '1.0.0' }
  }
}
const DISCOVER_MESSAGE = {
  jsonrpc: '2.0',
  id: 2,
  method: 'server/discover',
  params: { _meta: ENVELOPE }
}
const LIST_MESSAGE = { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }

const previousSecret = process.env.SYNAPTOMIND_SECRET
const previousServiceToken = process.env.SYNAPTOMIND_SERVICE_TOKEN
const previousInsecure = process.env.SYNAPTOMIND_ALLOW_INSECURE
process.env.SYNAPTOMIND_SECRET = SECRET
delete process.env.SYNAPTOMIND_SERVICE_TOKEN
delete process.env.SYNAPTOMIND_ALLOW_INSECURE

interface RunningServer {
  base: string
  server: McpHttpHandle
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') })
  const port = probe.port
  await probe.stop(true)
  if (port === undefined) throw new Error('Bun.serve did not report a bound port')
  return port
}

async function startServer(corsOrigins?: string[]): Promise<RunningServer> {
  const port = await freePort()
  const server = startMcpHttpServer('127.0.0.1', port, { corsOrigins })
  return { base: `http://127.0.0.1:${port}`, server }
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${SECRET}`, ...extra }
}

function modernHeaders(method: string, extra: Record<string, string> = {}): Record<string, string> {
  return authHeaders({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': MODERN,
    'mcp-method': method,
    ...extra
  })
}

function post(
  base: string,
  body: unknown,
  headers: Record<string, string>,
  contentType = 'application/json'
): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...headers, 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}

async function initializeLegacy(
  base: string,
  headers: Record<string, string> = {}
): Promise<string> {
  const res = await post(
    base,
    INIT_MESSAGE,
    authHeaders({
      accept: 'application/json, text/event-stream',
      ...headers
    })
  )
  const id = res.headers.get('mcp-session-id')
  await res.body?.cancel()
  if (!id) throw new Error(`initialize did not issue a session id (status ${res.status})`)
  return id
}

// The data frames of an SSE response, parsed. A priming frame carries an empty
// payload and is dropped.
function ssePayloads(text: string): any[] {
  return text
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trim())
    .filter(data => data.length > 0)
    .map(data => JSON.parse(data))
}

// A chunked body (no Content-Length) so the route's bounded read is the only
// thing that can stop it.
function streamBody(totalBytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(64 * 1024).fill(0x78)
  let sent = 0
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close()
        return
      }
      const size = Math.min(chunk.byteLength, totalBytes - sent)
      controller.enqueue(chunk.subarray(0, size))
      sent += size
    }
  })
}

beforeEach(createTestDb)

afterAll(() => {
  if (previousSecret === undefined) delete process.env.SYNAPTOMIND_SECRET
  else process.env.SYNAPTOMIND_SECRET = previousSecret
  if (previousServiceToken === undefined) delete process.env.SYNAPTOMIND_SERVICE_TOKEN
  else process.env.SYNAPTOMIND_SERVICE_TOKEN = previousServiceToken
  if (previousInsecure === undefined) delete process.env.SYNAPTOMIND_ALLOW_INSECURE
  else process.env.SYNAPTOMIND_ALLOW_INSECURE = previousInsecure
})

describe('modern era (2026-07-28)', () => {
  test('T-mod-1: envelope server/discover negotiates 2026-07-28 with no session', async () => {
    const { base, server } = await startServer()
    try {
      const res = await post(base, DISCOVER_MESSAGE, modernHeaders('server/discover'))
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.error).toBeUndefined()
      expect(body.result.supportedVersions).toContain(MODERN)

      // The modern leg keeps no session state: no header, no map entry.
      expect(res.headers.get('mcp-session-id')).toBeNull()
      expect(server.getSessions().size).toBe(0)
    } finally {
      await server.stop()
    }
  })

  test('T-mod-1: a claim-less server/discover is still routed to the legacy leg (400, not a negotiation)', async () => {
    const { base, server } = await startServer()
    try {
      const res = await post(
        base,
        { jsonrpc: '2.0', id: 9, method: 'server/discover', params: {} },
        authHeaders({ accept: 'application/json, text/event-stream' })
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' },
        id: null
      })
      expect(server.getSessions().size).toBe(0)
    } finally {
      await server.stop()
    }
  })

  test('T-mod-4: an envelope notification is acknowledged with 202 and creates no session', async () => {
    const { base, server } = await startServer()
    try {
      const res = await post(
        base,
        { jsonrpc: '2.0', method: 'notifications/initialized', params: { _meta: ENVELOPE } },
        modernHeaders('notifications/initialized')
      )
      expect(res.status).toBe(202)
      expect(await res.text()).toBe('')
      expect(server.getSessions().size).toBe(0)
    } finally {
      await server.stop()
    }
  })

  test('T-mod-7: a bad token on a modern discover is a 401, not a classification error', async () => {
    const { base, server } = await startServer()
    try {
      const res = await post(base, DISCOVER_MESSAGE, {
        ...modernHeaders('server/discover'),
        authorization: 'Bearer not-the-secret'
      })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Unauthorized' })
    } finally {
      await server.stop()
    }
  })
})

describe('legacy era regression', () => {
  test('T-leg-2: a request naming 2025-06-18 is still served by the sessionful leg', async () => {
    const { base, server } = await startServer()
    try {
      const sessionId = await initializeLegacy(base, { 'mcp-protocol-version': LEGACY })
      expect(sessionId).toBeString()

      const followUp = await post(
        base,
        LIST_MESSAGE,
        authHeaders({
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId
        })
      )
      expect(followUp.status).toBe(200)
      expect(followUp.headers.get('mcp-session-id')).toBe(sessionId)
      await followUp.body?.cancel()
    } finally {
      await server.stop()
    }
  })

  test('the legacy body bound is the unified 5 MiB, not the transport default 4 MiB', async () => {
    const { base, server } = await startServer()
    try {
      const sessionId = await initializeLegacy(base)
      const ping = (mb: number) =>
        post(
          base,
          {
            jsonrpc: '2.0',
            id: 2,
            method: 'ping',
            params: { pad: 'x'.repeat(Math.round(mb * 1024 * 1024)) }
          },
          authHeaders({
            accept: 'application/json, text/event-stream',
            'mcp-session-id': sessionId
          })
        )

      // 4–5 MiB: refused by the transport's old 4 MiB default, served now that
      // the bound is unified with the route's read. (The over-5 MiB half is
      // covered by the 413 cases above and in http-transport.test.ts.)
      const inside = await ping(4.4)
      expect(inside.status).toBe(200)
      await inside.body?.cancel()
    } finally {
      await server.stop()
    }
  })

  test('T-leg-3: getSessions() still exposes the sessions created by initialize', async () => {
    const { base, server } = await startServer()
    try {
      const first = await initializeLegacy(base)
      const second = await initializeLegacy(base)

      expect(server.getSessions().size).toBe(2)
      expect(server.getSessions().has(first)).toBe(true)
      expect(server.getSessions().has(second)).toBe(true)
      expect(server.getSessions().get(first)!.userId).toBe('legacy')
    } finally {
      await server.stop()
    }
  })
})

describe('negative ladder (modern path)', () => {
  test('T-neg-1: a modern version header over an initialize body is -32020', async () => {
    const { base, server } = await startServer()
    try {
      const res = await post(base, INIT_MESSAGE, modernHeaders('initialize'))
      expect(res.status).toBe(400)
      const body = (await res.json()) as any
      expect(body.error.code).toBe(-32020)
      expect(body.error.data.mismatch.header).toBe(MODERN)
      expect(server.getSessions().size).toBe(0)
    } finally {
      await server.stop()
    }
  })

  test('T-neg-2: an envelope naming an unknown revision is -32022 with data.supported', async () => {
    const { base, server } = await startServer()
    try {
      const unsupported = '2027-01-01'
      const res = await post(
        base,
        {
          jsonrpc: '2.0',
          id: 8,
          method: 'server/discover',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': unsupported,
              'io.modelcontextprotocol/clientCapabilities': {}
            }
          }
        },
        { ...modernHeaders('server/discover'), 'mcp-protocol-version': unsupported }
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as any
      expect(body.error.code).toBe(-32022)
      expect(body.error.data.supported).toEqual([MODERN])
      expect(body.error.data.requested).toBe(unsupported)
    } finally {
      await server.stop()
    }
  })

  test('T-neg-6: 415 answers a non-JSON POST on both eras without reading the body', async () => {
    const { base, server } = await startServer()
    try {
      const legacyShaped = await post(base, LIST_MESSAGE, authHeaders({}), 'text/plain')
      expect(legacyShaped.status).toBe(415)
      expect(await legacyShaped.json()).toEqual({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Unsupported Media Type: Content-Type must be application/json'
        },
        id: null
      })

      const modernShaped = await post(
        base,
        DISCOVER_MESSAGE,
        modernHeaders('server/discover'),
        'text/plain'
      )
      expect(modernShaped.status).toBe(415)

      // Chunked (no Content-Length) and oversized: 415 wins, so the body was
      // never read to its bound.
      const chunkedPlain = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: modernHeaders('server/discover', { 'content-type': 'text/plain' }),
        body: streamBody(6 * 1024 * 1024)
      })
      expect(chunkedPlain.status).toBe(415)
      await chunkedPlain.body?.cancel()

      expect(server.getSessions().size).toBe(0)
    } finally {
      await server.stop()
    }
  })

  test('T-neg-6: the declared-length 413 guard runs before the 415 check', async () => {
    const { base, server } = await startServer()
    try {
      const res = await post(base, 'x'.repeat(5 * 1024 * 1024 + 10), authHeaders({}), 'text/plain')
      expect(res.status).toBe(413)
      expect(await res.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Request body too large (max 5MB)' },
        id: null
      })
    } finally {
      await server.stop()
    }
  })

  test('T-neg-4: a session POST with invalid JSON keeps the -32700 wire answer', async () => {
    const { base, server } = await startServer()
    try {
      const sessionId = await initializeLegacy(base)
      const res = await post(
        base,
        '{not json',
        authHeaders({
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId
        })
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error: Invalid JSON' },
        id: null
      })
      expect(server.getSessions().has(sessionId)).toBe(true)
    } finally {
      await server.stop()
    }
  })

  test('T-neg-5: an unknown session id is still 404 with -32001', async () => {
    const { base, server } = await startServer()
    try {
      const res = await post(
        base,
        LIST_MESSAGE,
        authHeaders({ accept: 'application/json, text/event-stream', 'mcp-session-id': 'no-such' })
      )
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found' },
        id: null
      })
    } finally {
      await server.stop()
    }
  })
})

// Review #2438 F1: the SDK predicate classifies a body that parses as JSON but
// is not a JSON-RPC message as modern, so era classification — and with it the
// 415 media-type gate — now runs before the legacy session lookup. These cases
// lock that ordering; the raw strings are the wire bodies themselves, so `"x"`
// is the JSON string, not an unparseable `x`.
const NOT_A_MESSAGE = 'Bad Request: the request body is not a valid JSON-RPC message'
// An array is classified element-wise, so a bad element answers through the
// batch rule — still -32600, with its own wording.
const BAD_BATCH_ELEMENT = 'Bad Request: JSON-RPC batch contains an invalid message'

const NON_JSON_RPC_BODIES: ReadonlyArray<[string, string, string]> = [
  ['an empty object', '{}', NOT_A_MESSAGE],
  ['a null literal', 'null', NOT_A_MESSAGE],
  ['a bare JSON string', '"x"', NOT_A_MESSAGE],
  ['an array holding a number', '[1]', BAD_BATCH_ELEMENT]
]

describe('era classification precedes the legacy session ladder (#2438 F1)', () => {
  test.each(NON_JSON_RPC_BODIES)(
    'a sessioned POST of %s answers 400 with -32600, not the legacy -32700',
    async (_label, raw, message) => {
      const { base, server } = await startServer()
      try {
        const sessionId = await initializeLegacy(base)
        const res = await post(
          base,
          raw,
          authHeaders({
            accept: 'application/json, text/event-stream',
            'mcp-session-id': sessionId
          })
        )
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({
          jsonrpc: '2.0',
          error: { code: -32600, message },
          id: null
        })
        // The legacy session was neither consulted nor disturbed.
        expect(server.getSessions().has(sessionId)).toBe(true)
      } finally {
        await server.stop()
      }
    }
  )

  test.each(NON_JSON_RPC_BODIES)(
    'the same body of %s with an unknown session id is still 400 -32600, not 404',
    async (_label, raw, message) => {
      const { base, server } = await startServer()
      try {
        const res = await post(
          base,
          raw,
          authHeaders({
            accept: 'application/json, text/event-stream',
            'mcp-session-id': 'no-such'
          })
        )
        expect(res.status).toBe(400)
        const body = (await res.json()) as any
        expect(body.error.code).toBe(-32600)
        expect(body.error.message).toBe(message)
        expect(server.getSessions().size).toBe(0)
      } finally {
        await server.stop()
      }
    }
  )

  test('a text/plain POST with an unknown session id answers 415, while valid JSON-RPC still answers 404', async () => {
    const { base, server } = await startServer()
    try {
      const unknown = {
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'no-such'
      }

      const wrongMedia = await post(base, LIST_MESSAGE, authHeaders(unknown), 'text/plain')
      expect(wrongMedia.status).toBe(415)
      expect(await wrongMedia.json()).toEqual({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Unsupported Media Type: Content-Type must be application/json'
        },
        id: null
      })

      // The contrast: the same unknown id over a well-formed JSON-RPC body
      // still reaches the session ladder and keeps its 404 answer.
      const wellFormed = await post(base, LIST_MESSAGE, authHeaders(unknown))
      expect(wellFormed.status).toBe(404)
      const body = (await wellFormed.json()) as any
      expect(body.error.code).toBe(-32001)
    } finally {
      await server.stop()
    }
  })

  test('a JSON-RPC batch of legacy messages is still served by the sessionful leg', async () => {
    const { base, server } = await startServer()
    try {
      const sessionId = await initializeLegacy(base)
      const res = await post(
        base,
        [
          { jsonrpc: '2.0', id: 1, method: 'ping', params: {} },
          { jsonrpc: '2.0', id: 2, method: 'ping', params: {} }
        ],
        authHeaders({
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId
        })
      )
      // An all-legacy array stays legacy traffic: the sessionful transport
      // answers it as an SSE stream under the caller's session, where the
      // modern path would have refused the batch with -32600.
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      expect(res.headers.get('mcp-session-id')).toBe(sessionId)
      const answers = ssePayloads(await res.text())
      expect(answers.map(answer => answer.id)).toEqual([1, 2])
      for (const answer of answers) expect(answer.result).toEqual({})
    } finally {
      await server.stop()
    }
  })
})

describe('CORS (T-neg-8)', () => {
  test('an allowed preflight echoes the modern standard headers; a denied origin gets none', async () => {
    const { base, server } = await startServer([ALLOWED_ORIGIN])
    try {
      const preflight = (origin: string) =>
        fetch(`${base}/mcp`, {
          method: 'OPTIONS',
          headers: {
            origin,
            'access-control-request-method': 'POST',
            'access-control-request-headers':
              'authorization,content-type,mcp-method,mcp-name,mcp-protocol-version'
          }
        })

      const allowed = await preflight(ALLOWED_ORIGIN)
      expect(allowed.status).toBe(204)
      expect(allowed.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN)
      const allowedHeaders = (
        allowed.headers.get('access-control-allow-headers') ?? ''
      ).toLowerCase()
      for (const name of ['mcp-method', 'mcp-name', 'mcp-protocol-version']) {
        expect(allowedHeaders).toContain(name)
      }

      const denied = await preflight(DENIED_ORIGIN)
      expect(denied.status).toBe(204)
      expect(denied.headers.get('access-control-allow-origin')).toBeNull()
    } finally {
      await server.stop()
    }
  })
})
