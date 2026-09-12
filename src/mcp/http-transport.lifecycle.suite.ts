import { expect, mock, test } from 'bun:test'

// This suite must run in its own bun process (see http-transport.lifecycle.test.ts):
//  - it lowers the MCP transport timings via env, which only takes effect if no
//    other file imported the config singleton first;
//  - it replaces ./server before ./http-transport binds createMcpServer, so the
//    sessionless guard can be proven not to construct a server (F21).
process.env.SYNAPTOMIND_MCP_KEEPALIVE_MS = '50'
process.env.SYNAPTOMIND_MCP_SESSION_TTL_MS = '500'
process.env.SYNAPTOMIND_SECRET = 'mcp-lifecycle-suite-secret'
delete process.env.SYNAPTOMIND_SERVICE_TOKEN
delete process.env.SYNAPTOMIND_ALLOW_INSECURE

const TTL_MS = Number(process.env.SYNAPTOMIND_MCP_SESSION_TTL_MS)

// Load the real implementation and capture the function reference BEFORE
// mocking: reading it off the namespace after mock.module() would resolve to the
// mock itself (infinite recursion). The wrapper counts constructions while still
// delegating to the real factory.
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

const { startMcpHttpServer } = await import('./http-transport')
const { resetValidTokens } = await import('../auth')

const SECRET = process.env.SYNAPTOMIND_SECRET
const PROTOCOL_VERSION = '2025-06-18'
const INIT_MESSAGE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'http-transport-lifecycle-suite', version: '1.0.0' }
  }
}
const LIST_MESSAGE = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }

resetValidTokens()

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${SECRET}`, ...extra }
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') })
  const port = probe.port
  await probe.stop(true)
  if (port === undefined) throw new Error('Bun.serve did not report a bound port')
  return port
}

function rpc(base: string, body: unknown, sessionId?: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: authHeaders({
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {})
    }),
    body: JSON.stringify(body)
  })
}

async function initialize(base: string): Promise<string> {
  const res = await rpc(base, INIT_MESSAGE)
  const id = res.headers.get('mcp-session-id')
  await res.body?.cancel()
  if (!id) throw new Error(`initialize did not issue a session id (status ${res.status})`)
  return id
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))
  ])
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

test('F4: an active SSE stream refreshes lastAccess and keeps its session past the TTL', async () => {
  const port = await freePort()
  const server = startMcpHttpServer('127.0.0.1', port)
  const base = `http://127.0.0.1:${port}`
  try {
    const sessionId = await initialize(base)
    const session = server.getSessions().get(sessionId)
    expect(session).toBeDefined()

    const streamRes = await fetch(`${base}/mcp`, {
      method: 'GET',
      headers: authHeaders({ accept: 'text/event-stream', 'mcp-session-id': sessionId })
    })
    expect(streamRes.status).toBe(200)
    expect(streamRes.headers.get('content-type')).toContain('text/event-stream')

    // Simulate the TTL having already elapsed before the stream delivers bytes.
    // Any later refresh can only come from trackStreamActivity.
    session!.lastAccess = 0

    const reader = streamRes.body!.getReader()
    const streamStart = Date.now()
    let sawActivity = false
    try {
      while (Date.now() - streamStart < TTL_MS * 3) {
        const { value, done } = await withTimeout(reader.read(), 1000)
        if (done) break
        if (value && value.length > 0) sawActivity = true
        // Keep the stream flowing for strictly longer than the TTL.
        if (Date.now() - streamStart > TTL_MS && session!.lastAccess > 0) break
      }
    } finally {
      await reader.cancel()
    }

    expect(sawActivity).toBe(true)
    // Still open, and the sweeper's `now - lastAccess > TTL` predicate is false.
    expect(server.getSessions().has(sessionId)).toBe(true)
    expect(Date.now() - streamStart).toBeGreaterThan(TTL_MS)
    expect(session!.lastAccess).toBeGreaterThan(0)
    expect(Date.now() - session!.lastAccess).toBeLessThan(TTL_MS)
  } finally {
    await server.stop()
  }
})

test('F20: stop() awaits every per-session close before resolving and clears the map', async () => {
  const port = await freePort()
  const server = startMcpHttpServer('127.0.0.1', port)
  const base = `http://127.0.0.1:${port}`
  const events: string[] = []
  let stopped = false
  try {
    const sessionIds = [await initialize(base), await initialize(base)]
    for (const id of sessionIds) {
      const session = server.getSessions().get(id)
      expect(session).toBeDefined()
      // Replace the real close with a slow spy: if stop() did not await it,
      // 'stop-resolved' would be recorded before the transport closes.
      const transport = session!.transport as unknown as { close: () => Promise<void> }
      transport.close = async () => {
        await delay(40)
        events.push(`transport:${id}`)
      }
    }

    const stopPromise = server.stop()
    void stopPromise.then(() => events.push('stop-resolved'))
    await stopPromise
    stopped = true

    // Every session's transport close ran (server.close() may close it a second
    // time), and stop() did not resolve until the slow closes completed.
    const closedIds = new Set(events.filter(e => e.startsWith('transport:')).map(e => e.slice('transport:'.length)))
    expect(closedIds).toEqual(new Set(sessionIds))
    expect(events.at(-1)).toBe('stop-resolved')
    expect(server.getSessions().size).toBe(0)
  } finally {
    if (!stopped) await server.stop()
  }
})

test('F21: a sessionless non-initialize request returns a 400 JSON-RPC without constructing a server', async () => {
  const port = await freePort()
  const server = startMcpHttpServer('127.0.0.1', port)
  const base = `http://127.0.0.1:${port}`
  try {
    const before = createCount
    const res = await rpc(base, LIST_MESSAGE)

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' },
      id: null
    })
    // The guard rejects before createMcpServer/transport construction.
    expect(createCount).toBe(before)

    // Sanity: the counter does observe a real initialize, so the assertion above
    // is meaningful rather than a mocked-out no-op.
    await initialize(base)
    expect(createCount).toBe(before + 1)
  } finally {
    await server.stop()
  }
})
