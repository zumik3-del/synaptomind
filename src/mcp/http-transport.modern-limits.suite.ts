import { expect, mock, test } from 'bun:test'

// Runs in its own bun process (see http-transport.modern-limits.test.ts): the
// subscription/session caps and the factory counter both only work when the env
// is read before the config singleton exists and ./server is replaced before
// ./http-transport binds it.
process.env.SYNAPTOMIND_MCP_MAX_SUBSCRIPTIONS = '2'
process.env.SYNAPTOMIND_MCP_MAX_SESSIONS = '2'
process.env.SYNAPTOMIND_SECRET = 'mcp-modern-limits-suite-secret'
delete process.env.SYNAPTOMIND_SERVICE_TOKEN
delete process.env.SYNAPTOMIND_ALLOW_INSECURE

const realServer = await import('./server')
const realCreateMcpServer = realServer.createMcpServer
let createCount = 0
mock.module('./server', () => ({
  ...realServer,
  createMcpServer: () => {
    createCount++
    return realCreateMcpServer()
  }
}))

const { startMcpHttpServer, MAX_REQUEST_BODY_BYTES } = await import('./http-transport')
const { config } = await import('../config')
const { createTestDb } = await import('../test/helpers')

const SECRET = process.env.SYNAPTOMIND_SECRET
const MODERN = '2026-07-28'
const LEGACY = '2025-06-18'
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
    clientInfo: { name: 'modern-limits-suite', version: '1.0.0' }
  }
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

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') })
  const port = probe.port
  await probe.stop(true)
  if (port === undefined) throw new Error('Bun.serve did not report a bound port')
  return port
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms))
  ])
}

interface SseReader {
  read(): Promise<{ value?: Uint8Array; done: boolean }>
}

async function nextFrame(reader: SseReader, timeoutMs = 2000): Promise<string> {
  const decoder = new TextDecoder()
  let acc = ''
  while (!acc.includes('\n\n')) {
    const { value, done } = await withTimeout(reader.read(), timeoutMs, 'SSE frame')
    if (done) break
    if (value) acc += decoder.decode(value, { stream: true })
  }
  return acc
}

async function readUntilDone(reader: SseReader, timeoutMs = 2000): Promise<string> {
  const decoder = new TextDecoder()
  let acc = ''
  for (;;) {
    const { value, done } = await withTimeout(reader.read(), timeoutMs, 'SSE teardown')
    if (done) return acc
    if (value) acc += decoder.decode(value, { stream: true })
  }
}

function listen(base: string, id: number): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: modernHeaders('subscriptions/listen'),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'subscriptions/listen',
      params: { notifications: { toolsListChanged: true }, _meta: ENVELOPE }
    })
  })
}

function discover(base: string, id = 90): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: modernHeaders('server/discover'),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'server/discover',
      params: { _meta: ENVELOPE }
    })
  })
}

async function initializeLegacy(base: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: authHeaders({
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    }),
    body: JSON.stringify(INIT_MESSAGE)
  })
}

async function openSession(base: string): Promise<string> {
  const res = await initializeLegacy(base)
  const id = res.headers.get('mcp-session-id')
  await res.body?.cancel()
  if (!id) throw new Error(`initialize did not issue a session id (status ${res.status})`)
  return id
}

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

createTestDb()

test('T-mod-5: subscriptions/listen acks first and the third stream is refused in-band', async () => {
  expect(config.mcp.maxSubscriptions).toBe(2)

  const port = await freePort()
  const server = startMcpHttpServer('127.0.0.1', port)
  const base = `http://127.0.0.1:${port}`
  try {
    const first = await listen(base, 501)
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toContain('text/event-stream')
    expect(first.headers.get('mcp-session-id')).toBeNull()
    const firstReader = first.body!.getReader()
    const ack = await nextFrame(firstReader)
    expect(ack).toContain('notifications/subscriptions/acknowledged')
    expect(ack).toContain('"toolsListChanged":true')
    expect(ack).toContain('"io.modelcontextprotocol/subscriptionId":501')

    const second = await listen(base, 502)
    expect(second.status).toBe(200)
    const secondReader = second.body!.getReader()
    expect(await nextFrame(secondReader)).toContain('"io.modelcontextprotocol/subscriptionId":502')

    const third = await listen(base, 503)
    expect(third.status).toBe(200)
    expect(third.headers.get('content-type')).toContain('application/json')
    expect(await third.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Subscription limit reached' },
      id: 503
    })

    expect(server.getSessions().size).toBe(0)

    await withTimeout(server.stop(), 5000, 'stop()')

    const firstTail = await readUntilDone(firstReader)
    expect(firstTail).toContain('"id":501')
    const secondTail = await readUntilDone(secondReader)
    expect(secondTail).toContain('"id":502')
    expect(server.getSessions().size).toBe(0)
  } finally {
    await server.stop()
  }
})

test('T-neg-3: both oversized shapes answer 413 without constructing a server', async () => {
  const port = await freePort()
  const server = startMcpHttpServer('127.0.0.1', port)
  const base = `http://127.0.0.1:${port}`
  try {
    const before = createCount

    const declared = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: modernHeaders('server/discover'),
      body: JSON.stringify({ ...INIT_MESSAGE, pad: 'x'.repeat(MAX_REQUEST_BODY_BYTES) })
    })
    expect(declared.status).toBe(413)
    expect(await declared.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Request body too large (max 5MB)' },
      id: null
    })
    expect(createCount).toBe(before)

    const chunked = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: modernHeaders('server/discover'),
      body: streamBody(MAX_REQUEST_BODY_BYTES + 1024)
    })
    expect(chunked.status).toBe(413)
    expect(await chunked.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Request body too large (max 5MB)' },
      id: null
    })
    expect(createCount).toBe(before)

    const ok = await discover(base)
    expect(ok.status).toBe(200)
    await ok.body?.cancel()
    expect(createCount).toBe(before + 1)
  } finally {
    await server.stop()
  }
})

test('T-neg-7: maxSessions caps legacy sessions only, never the modern era', async () => {
  const port = await freePort()
  const server = startMcpHttpServer('127.0.0.1', port)
  const base = `http://127.0.0.1:${port}`
  try {
    await openSession(base)
    await openSession(base)
    expect(server.getSessions().size).toBe(2)

    const before = createCount
    const overflow = await initializeLegacy(base)
    expect(overflow.status).toBe(429)
    expect(await overflow.json()).toEqual({ error: 'Too many sessions' })
    expect(server.getSessions().size).toBe(2)
    expect(createCount).toBe(before)

    for (const id of [91, 92, 93]) {
      const res = await discover(base, id)
      expect(res.status).toBe(200)
      await res.body?.cancel()
    }
    expect(server.getSessions().size).toBe(2)
  } finally {
    await server.stop()
  }
})
