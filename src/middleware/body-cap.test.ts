import type { McpHttpHandler } from '@modelcontextprotocol/server'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createApp } from '../api/router'
import { createMcpRouteHandler, SessionRegistry } from '../mcp/mcp-route'
import { createMcpServer } from '../mcp/server'
import { createGuardedPipeline } from '../middleware/guarded-pipeline'
import { createErrorHandler, MAX_REQUEST_BODY_BYTES } from '../middleware/http-errors'
import { configFixture } from '../test/helpers'

// Task #2615: the cap is pinned where it used to be trusted rather than measured — a chunked body,
// and a body that lies about its length, must both be cut by the bytes actually read. Every `/api`
// case runs against the real `createApp()`, so the mount in `src/api/router.ts` is under test too.

const SECRET = 'body-cap-test-secret'
const BODY_TOO_LARGE = { error: 'Request body too large (max 5MB)' }
const UNSUPPORTED_MEDIA_TYPE = {
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Unsupported Media Type: Content-Type must be application/json' },
  id: null
}

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

// A body that declares no length, the way a chunked upload arrives: only counting what streams in
// can enforce the cap.
function chunked(bytes: number): ReadableStream<Uint8Array> {
  let sent = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) return controller.close()
      const size = Math.min(65_536, bytes - sent)
      sent += size
      controller.enqueue(new Uint8Array(size).fill(0x78))
    }
  })
}

// The real app plus one echo route, so a request that gets past the cap is observable by whether
// the handler ran and what it was handed.
function probeApp(): { app: Hono; handlerRuns: () => number } {
  const app = createApp(singleUser)
  let runs = 0
  app.post('/api/probe', async c => {
    runs++
    return c.json({ received: (await c.req.text()).length })
  })
  return { app, handlerRuns: () => runs }
}

function apiRequest(
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {}
): Request {
  return new Request('http://localhost/api/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}`, ...headers },
    body
  })
}

describe('the /api body cap counts bytes while reading', () => {
  test('a chunked body one byte over the cap answers 413 and never reaches the handler', async () => {
    const { app, handlerRuns } = probeApp()
    const res = await app.fetch(apiRequest(chunked(MAX_REQUEST_BODY_BYTES + 1)))

    expect(res.status).toBe(413)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual(BODY_TOO_LARGE)
    expect(handlerRuns()).toBe(0)
  })

  test('a chunked body under the cap and one of exactly the cap both reach the handler', async () => {
    const { app, handlerRuns } = probeApp()

    const under = await app.fetch(apiRequest(chunked(MAX_REQUEST_BODY_BYTES - 1024)))
    expect(under.status).toBe(200)
    expect(await under.json()).toEqual({ received: MAX_REQUEST_BODY_BYTES - 1024 })

    const exact = await app.fetch(apiRequest(chunked(MAX_REQUEST_BODY_BYTES)))
    expect(exact.status).toBe(200)
    expect(await exact.json()).toEqual({ received: MAX_REQUEST_BODY_BYTES })

    expect(handlerRuns()).toBe(2)
  })

  test('a content-length that understates a chunked body buys no pass', async () => {
    const { app, handlerRuns } = probeApp()
    const res = await app.fetch(
      apiRequest(chunked(MAX_REQUEST_BODY_BYTES + 1), { 'content-length': '16' })
    )

    expect(res.status).toBe(413)
    expect(await res.json()).toEqual(BODY_TOO_LARGE)
    expect(handlerRuns()).toBe(0)
  })

  test('an unauthenticated oversized chunked request answers 401 without reading the body', async () => {
    const { app, handlerRuns } = probeApp()
    const request = new Request('http://localhost/api/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: chunked(MAX_REQUEST_BODY_BYTES + 1)
    })
    const res = await app.fetch(request)

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
    expect(request.bodyUsed).toBe(false)
    expect(handlerRuns()).toBe(0)
  })
})

describe('the /mcp surface keeps its own ordering', () => {
  // The documented divergence: /mcp answers 415 for a non-JSON media type before it reads, so it
  // cannot mount a counting reader ahead of the route. Wiring one there would turn this 415 into a
  // 413, and the untouched body pins that the media type is decided first.
  test('a chunked over-cap body with a non-JSON media type answers 415, not 413', async () => {
    const modern: McpHttpHandler = createMcpHandler(() => createMcpServer(), {
      legacy: 'reject',
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES
    })
    try {
      const app = new Hono()
      app.onError(createErrorHandler('jsonrpc'))
      for (const guard of createGuardedPipeline({ shape: 'jsonrpc', config: singleUser }))
        app.use('/mcp', guard)
      app.all(
        '/mcp',
        createMcpRouteHandler({
          registry: new SessionRegistry({
            maxSessions: 1,
            keepAliveMs: 1_000,
            maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES,
            ttlMs: 1_000
          }),
          modern,
          maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES
        })
      )

      const request = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${SECRET}`
        },
        body: chunked(MAX_REQUEST_BODY_BYTES + 1)
      })
      const res = await app.fetch(request)

      expect(res.status).toBe(415)
      expect(await res.json()).toEqual(UNSUPPORTED_MEDIA_TYPE)
      expect(request.bodyUsed).toBe(false)
    } finally {
      await modern.close()
    }
  })
})
