import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { once } from 'node:events'
import { connect, type Socket } from 'node:net'
import { createTestDb } from '../test/helpers'
import { mcpErrorHandler, startMcpHttpServer, type McpHttpHandle } from './http-transport'
import { DRAIN_BODY_BYTES } from './request-body'
import type { Context } from 'hono'

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
  port: number
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
  return { base: `http://127.0.0.1:${port}`, port, server }
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

// Locked by #2442: an early rejection that leaves the request body unread keeps
// that request in flight, so Bun's server.stop() waits forever and the suite
// died as a bare 5 s bun-test timeout. Bound the stop, so a comeback names the
// cause instead of hiding inside the runner's timeout.
const STOP_TIMEOUT_MS = 2_000

// A body that reports what the socket actually moved, so the drain's bound is
// observable from the client side: `sent()` is what left the process,
// `cancelObserved()` fires when Bun cancels the source (the server stopped
// reading), and `saturated()` fires once the whole body was handed over.
interface RecordingUpload {
  body: ReadableStream<Uint8Array>
  sent(): number
  sentAtCancel(): number | undefined
  cancelObserved(): Promise<void>
  saturated(): Promise<void>
}

interface RecordingOptions {
  chunkBytes?: number
  onSent?(sent: number): void
}

function recordingUpload(
  totalBytes: number,
  { chunkBytes = 16 * 1024, onSent }: RecordingOptions = {}
): RecordingUpload {
  const chunk = new Uint8Array(chunkBytes).fill(0x78)
  let sent = 0
  let sentAtCancel: number | undefined
  let markCancelled: () => void = () => {}
  let markSaturated: () => void = () => {}
  const cancelObserved = new Promise<void>(resolve => (markCancelled = resolve))
  const saturated = new Promise<void>(resolve => (markSaturated = resolve))
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close()
        return
      }
      const size = Math.min(chunkBytes, totalBytes - sent)
      controller.enqueue(chunk.subarray(0, size))
      sent += size
      if (sent >= totalBytes) {
        markSaturated()
        return
      }
      onSent?.(sent)
    },
    cancel() {
      sentAtCancel = sent
      markCancelled()
    }
  })
  return {
    body,
    sent: () => sent,
    sentAtCancel: () => sentAtCancel,
    cancelObserved: () => cancelObserved,
    saturated: () => saturated
  }
}

// Same shape as expectStopResolves, for the client-side observation a drain
// bound or an abort has to produce: a comeback names the missing signal instead
// of hanging until the runner's timeout.
async function expectWithinDeadline(work: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} within ${STOP_TIMEOUT_MS} ms`)),
          STOP_TIMEOUT_MS
        )
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function expectStopResolves(server: McpHttpHandle, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      server.stop(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${label}: server.stop() did not resolve within ${STOP_TIMEOUT_MS} ms — a request body left unread keeps the request in flight`
              )
            ),
          STOP_TIMEOUT_MS
        )
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
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
      await expectStopResolves(server, '413 declared length with an oversized body')
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

// #2442: the 401 and the 415 below also answer before the body is consumed
// (auth runs first, the media-type gate runs before any read), and the 413 in
// the ladder above is the third shape. Together they cover every early rejection
// that used to keep a request in flight and stall the graceful shutdown.
describe('shutdown after a rejection that leaves the body unread (#2442)', () => {
  const OVERSIZED = 5 * 1024 * 1024 + 10

  test('a 401 on an oversized POST still lets server.stop() resolve', async () => {
    const { base, server } = await startServer()
    try {
      const res = await post(base, 'x'.repeat(OVERSIZED), {
        authorization: 'Bearer not-the-secret'
      })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Unauthorized' })
    } finally {
      await expectStopResolves(server, '401 with an oversized body')
    }
  })

  test('a 415 on an oversized text/plain POST still lets server.stop() resolve', async () => {
    const { base, server } = await startServer()
    try {
      // Chunked, so the declared-length 413 guard cannot pre-empt the 415.
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: authHeaders({
          'content-type': 'text/plain',
          accept: 'application/json, text/event-stream'
        }),
        body: streamBody(OVERSIZED)
      })
      expect(res.status).toBe(415)
      expect(await res.json()).toEqual({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Unsupported Media Type: Content-Type must be application/json'
        },
        id: null
      })
      expect(server.getSessions().size).toBe(0)
    } finally {
      await expectStopResolves(server, '415 with an oversized body')
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

// #2463: the drain that settles a rejected POST is bounded to DRAIN_BODY_BYTES,
// and a client that closes the socket mid-body is answered, not blamed. Both
// cases drive the real listener. The drain lives in the `/mcp` middleware that
// wraps the whole chain, so it runs BEFORE era classification and applies to
// both eras alike: the 401 below is refused by the auth middleware (no era yet),
// the 415 by the route's media-type gate — neither reaches the legacy session
// ladder or the modern entry, which is exactly why they are the drain's shapes.
const DRAIN_UPLOAD_BYTES = 8 * 1024 * 1024
// The server stops reading at the cap; when the cancel lands the client may be
// one socket-buffer window ahead of it, so that window is allowed on top. The
// unbounded shape this replaces moved the whole 8 MiB.
const SOCKET_WINDOW_BYTES = 128 * 1024

describe('bounded drain of a rejected body (#2463)', () => {
  test('T-drain-1: a 401 on a chunked 8 MiB POST answers at the 64 KiB cap and cancels the upload', async () => {
    const { base, server } = await startServer()
    const upload = recordingUpload(DRAIN_UPLOAD_BYTES)
    try {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { authorization: 'Bearer not-the-secret', 'content-type': 'application/json' },
        body: upload.body
      })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Unauthorized' })

      // An abandoned body cannot be settled by the cancel, so the answer has to
      // end the connection; that is also what a fetch client sees here (#2488).
      expect(res.headers.get('connection')).toBe('close')

      // The rejection is already answered; the drain then cancels instead of
      // reading 8 MiB, which is the only way the bound is visible from here.
      await expectWithinDeadline(
        upload.cancelObserved(),
        'the rejected upload was never cancelled, so the drain read past the cap'
      )
      expect(upload.sentAtCancel()).toBeNumber()
      expect(upload.sentAtCancel()!).toBeLessThanOrEqual(DRAIN_BODY_BYTES + SOCKET_WINDOW_BYTES)
      expect(upload.sent()).toBeLessThan(DRAIN_UPLOAD_BYTES / 4)
    } finally {
      await expectStopResolves(server, '401 with a chunked 8 MiB body')
    }
  })

  test('T-drain-2: a 415 on the modern path drains a sub-cap body to the end instead of cancelling it', async () => {
    const { base, server } = await startServer()
    // Under the cap on purpose: the bound must not truncate a body the drain can
    // still settle completely, which is what keeps the request from stalling.
    const upload = recordingUpload(40 * 1024)
    try {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: modernHeaders('server/discover', { 'content-type': 'text/plain' }),
        body: upload.body
      })
      expect(res.status).toBe(415)
      expect(await res.json()).toEqual({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Unsupported Media Type: Content-Type must be application/json'
        },
        id: null
      })
      await expectWithinDeadline(
        upload.saturated(),
        'the drain stopped before the end of a rejected body under the cap'
      )
      expect(upload.sent()).toBe(40 * 1024)
      expect(upload.sentAtCancel()).toBeUndefined()
      // A body drained to its end is consumed, not abandoned: the connection has
      // nothing outstanding and must stay reusable.
      expect(res.headers.get('connection')).not.toBe('close')
      // The modern-shaped rejection never touched the sessionful leg.
      expect(server.getSessions().size).toBe(0)
    } finally {
      await expectStopResolves(server, '415 with a sub-cap body')
    }
  })
})

// #2464: the header is only the announcement — an abandoned body settles the
// request when the connection actually ends, and a consumed one must leave the
// connection reusable. fetch hides both, so these cases speak HTTP/1.1 on a raw
// socket and read the exchange frame by frame.
interface WireResponse {
  status: number
  headers: Map<string, string>
  body: string
}

class WireConnection {
  private buffer: Buffer = Buffer.alloc(0)
  private closed = false
  private readonly waiters = new Set<() => void>()

  private constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.notify()
    })
    const markClosed = () => {
      this.closed = true
      this.notify()
    }
    socket.on('close', markClosed)
    socket.on('error', markClosed)
  }

  static async open(port: number): Promise<WireConnection> {
    const socket = connect({ host: '127.0.0.1', port })
    await once(socket, 'connect')
    return new WireConnection(socket)
  }

  send(data: string | Buffer): void {
    this.socket.write(data)
  }

  /** One Content-Length delimited response; the server answers JSON here. */
  async readResponse(label: string): Promise<WireResponse> {
    for (;;) {
      const headEnd = this.buffer.indexOf('\r\n\r\n')
      if (headEnd !== -1) {
        const [statusLine = '', ...headerLines] = this.buffer
          .subarray(0, headEnd)
          .toString('latin1')
          .split('\r\n')
        const headers = new Map<string, string>()
        for (const line of headerLines) {
          const colon = line.indexOf(':')
          if (colon !== -1) {
            headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
          }
        }
        const length = Number(headers.get('content-length'))
        if (Number.isNaN(length)) {
          throw new Error(`${label}: response without Content-Length: ${statusLine}`)
        }
        const bodyStart = headEnd + 4
        if (this.buffer.length >= bodyStart + length) {
          const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
          this.buffer = this.buffer.subarray(bodyStart + length)
          return { status: Number.parseFloat(statusLine.split(' ')[1] ?? ''), headers, body }
        }
      }
      if (this.closed) throw new Error(`${label}: the connection closed before a complete response`)
      await this.wait()
    }
  }

  async waitForClose(label: string): Promise<void> {
    await expectWithinDeadline(
      (async () => {
        while (!this.closed) await this.wait()
      })(),
      label
    )
  }

  destroy(): void {
    this.socket.destroy()
  }

  private notify(): void {
    for (const wake of this.waiters) wake()
    this.waiters.clear()
  }

  private wait(): Promise<void> {
    return new Promise<void>(resolve => this.waiters.add(resolve))
  }
}

interface RawPost {
  authorization: string
  contentLength: number
  contentType?: string
  extraHeaders?: string[]
}

function rawPostHead({
  authorization,
  contentLength,
  contentType = 'application/json',
  extraHeaders = []
}: RawPost): string {
  return [
    'POST /mcp HTTP/1.1',
    'Host: 127.0.0.1',
    `Authorization: Bearer ${authorization}`,
    `Content-Type: ${contentType}`,
    ...extraHeaders,
    `Content-Length: ${contentLength}`,
    '',
    ''
  ].join('\r\n')
}

describe('connection handling of a rejected body (#2464)', () => {
  // The drain middleware wraps the whole `/mcp` chain, so it runs before era
  // classification and both eras are drained by the same code. The 401 here is
  // answered before an era exists at all (auth gate), which is the abandoned
  // shape: over the cap, so the drain cancels instead of reading it.
  test('T-drain-3: an abandoned over-cap body is answered 401 with Connection: close and ends the connection', async () => {
    const { port, server } = await startServer()
    const connection = await WireConnection.open(port)
    try {
      // Declared 8 MiB, 4 KiB on the wire: the client still has bytes to send,
      // which is exactly the shape a bare cancel left in flight (#2463 → #2488).
      connection.send(
        rawPostHead({ authorization: 'not-the-secret', contentLength: DRAIN_UPLOAD_BYTES })
      )
      connection.send(Buffer.alloc(4 * 1024, 0x78))
      const res = await connection.readResponse('401 on an abandoned 8 MiB body')
      expect(res.status).toBe(401)
      expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' })
      expect(res.headers.get('connection')).toBe('close')
      // The close itself is what settles the request; without it server.stop()
      // waits forever, which the bound on stop() in the finally block reports.
      await connection.waitForClose(
        'the abandoned request was never closed, so server.stop() would wait for it'
      )
    } finally {
      connection.destroy()
      await expectStopResolves(server, '401 with an abandoned 8 MiB body')
    }
  })

  // The rejected request below carries no modern version claim, so it is the
  // legacy shape (the same shape T-neg-6 names) — but the 415 gate answers
  // before era classification, just as it does for the modern-shaped upload in
  // T-drain-2, and the drain middleware wraps both eras alike. The follow-up on
  // the same socket proves the drained connection survived, which is exactly
  // what the abandoned path gives up.
  test('T-drain-4: a sub-cap rejection keeps the connection alive for the next request', async () => {
    const { port, server } = await startServer()
    const connection = await WireConnection.open(port)
    const body = Buffer.alloc(40 * 1024, 0x78)
    try {
      connection.send(
        rawPostHead({
          authorization: SECRET,
          contentType: 'text/plain',
          contentLength: body.byteLength
        })
      )
      connection.send(body)
      const rejected = await connection.readResponse('415 on a sub-cap body')
      expect(rejected.status).toBe(415)
      expect(JSON.parse(rejected.body)).toEqual({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Unsupported Media Type: Content-Type must be application/json'
        },
        id: null
      })
      expect(rejected.headers.get('connection')).not.toBe('close')

      const discover = JSON.stringify(DISCOVER_MESSAGE)
      connection.send(
        rawPostHead({
          authorization: SECRET,
          contentLength: Buffer.byteLength(discover),
          extraHeaders: [
            'Accept: application/json, text/event-stream',
            `mcp-protocol-version: ${MODERN}`,
            'mcp-method: server/discover'
          ]
        })
      )
      connection.send(discover)
      const next = await connection.readResponse('the request after a sub-cap rejection')
      expect(next.status).toBe(200)
      expect(JSON.parse(next.body).result.supportedVersions).toContain(MODERN)
      expect(server.getSessions().size).toBe(0)
    } finally {
      connection.destroy()
      await expectStopResolves(server, '415 with a sub-cap body')
    }
  })
})

// #2463: Bun rejects the body read with a DOMException named AbortError when the
// client closes the socket mid-upload. That is the caller going away, not a
// server fault: it must answer 4xx and must not log at error level.
function clientAbortError(): Error {
  return new DOMException('The connection was closed.', 'AbortError')
}

// The minimal Context an error handler uses: only the non-abort branch touches
// it, and this stub is Hono's own `c.json` shape.
function stubContext(): Context {
  return {
    json: (body: unknown, status = 200) => Response.json(body, { status })
  } as unknown as Context
}

describe('a mid-body client abort (#2463)', () => {
  test('T-abort-1: the abort answers 400 with -32700 and logs nothing', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = mcpErrorHandler(clientAbortError(), stubContext())
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error: Invalid JSON' },
        id: null
      })
      expect(errorSpy).toHaveBeenCalledTimes(0)
    } finally {
      errorSpy.mockRestore()
    }
  })

  test('T-abort-1: a genuine internal error still answers 500 and logs once', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = mcpErrorHandler(new Error('boom'), stubContext())
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
        id: null
      })
      expect(errorSpy).toHaveBeenCalledTimes(1)
    } finally {
      errorSpy.mockRestore()
    }
  })

  test('T-abort-2: a real mid-upload abort logs nothing at error level and never stalls shutdown', async () => {
    const { base, server } = await startServer()
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const controller = new AbortController()
    // Abort once the upload is visibly moving AND the request is on the wire:
    // aborting inside the pull would cancel before the headers are flushed, and
    // the abort would then never reach the server's body read. A zero-delay
    // macrotask lets Bun push the frames it already has — a real client timing,
    // not a sleep standing in for one.
    let abortAfterStart: () => void = () => {}
    const uploadStarted = new Promise<void>(resolve => (abortAfterStart = resolve))
    const upload = recordingUpload(DRAIN_UPLOAD_BYTES, {
      onSent: sent => {
        if (sent < 2 * 16 * 1024) return
        setTimeout(() => {
          controller.abort()
          abortAfterStart()
        }, 0)
      }
    })
    try {
      const outcomePromise = fetch(`${base}/mcp`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: upload.body,
        signal: controller.signal
      }).then(
        res => res,
        (err: Error) => err
      )
      await expectWithinDeadline(
        uploadStarted,
        'the upload never started, so no abort could reach the server'
      )
      const outcome = await outcomePromise
      expect(outcome).toBeInstanceOf(Error)
      expect((outcome as Error).name).toBe('AbortError')
      await expectStopResolves(server, 'client abort mid-body')
      expect(errorSpy).toHaveBeenCalledTimes(0)
    } finally {
      errorSpy.mockRestore()
    }
  })
})
