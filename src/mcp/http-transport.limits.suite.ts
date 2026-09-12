import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Runs in its own bun process (see http-transport.limits.test.ts): the config
// singleton is built at first import, so the env overrides below only take
// effect if no other suite imported ../config first. This suite proves task
// #170 finding F16: the MCP transport limits are config-driven, not hard-coded.
process.env.SYNAPTOMIND_MCP_MAX_SESSIONS = '2'
process.env.SYNAPTOMIND_MCP_SESSION_TTL_MS = '1234'
process.env.SYNAPTOMIND_MCP_KEEPALIVE_MS = '4321'
process.env.SYNAPTOMIND_MCP_MAX_EVENTS_PER_SESSION = '3'
process.env.SYNAPTOMIND_SECRET = 'mcp-limits-suite-secret'
delete process.env.SYNAPTOMIND_SERVICE_TOKEN
delete process.env.SYNAPTOMIND_ALLOW_INSECURE

const { config } = await import('../config')
const { startMcpHttpServer, InMemoryEventStore, MAX_EVENTS_PER_SESSION } = await import('./http-transport')
const { resetValidTokens } = await import('../auth')

resetValidTokens()

const SECRET = process.env.SYNAPTOMIND_SECRET
const PROTOCOL_VERSION = '2025-06-18'
const INIT_MESSAGE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'http-transport-limits-suite', version: '1.0.0' }
  }
}

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

function rpc(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' }),
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

test('mcp transport limit env overrides parse as ints', () => {
  expect(config.mcp.maxSessions).toBe(2)
  expect(config.mcp.sessionTtlMs).toBe(1234)
  expect(config.mcp.keepAliveMs).toBe(4321)
  expect(config.mcp.maxEventsPerSession).toBe(3)
})

test('transport constants are assigned from config.mcp', () => {
  const source = readFileSync(join(import.meta.dir, 'http-transport.ts'), 'utf8')

  expect(source).toContain('const MAX_SESSIONS = config.mcp.maxSessions')
  expect(source).toContain('const SESSION_TTL_MS = config.mcp.sessionTtlMs')
  expect(source).toContain('const KEEPALIVE_MS = config.mcp.keepAliveMs')
  expect(source).toContain('export const MAX_EVENTS_PER_SESSION = config.mcp.maxEventsPerSession')
  expect(MAX_EVENTS_PER_SESSION).toBe(config.mcp.maxEventsPerSession)
})

test('the event-store cap follows the configured maxEventsPerSession', async () => {
  const store = new InMemoryEventStore()
  const first = await store.storeEvent('stream-a', { n: -1 })
  for (let i = 0; i < config.mcp.maxEventsPerSession; i++) {
    await store.storeEvent('stream-a', { n: i })
  }

  const sent: string[] = []
  const streamId = await store.replayEventsAfter(first, { send: async id => { sent.push(id) } })
  expect(streamId).toBe('')
  expect(sent).toEqual([])
})

test('maxSessions caps concurrent sessions with 429 and keepAlive is forwarded', async () => {
  const port = await freePort()
  const server = startMcpHttpServer('127.0.0.1', port)
  const base = `http://127.0.0.1:${port}`
  try {
    const firstId = await initialize(base)
    await initialize(base)
    expect(server.getSessions().size).toBe(2)

    const overflow = await rpc(base, INIT_MESSAGE)
    expect(overflow.status).toBe(429)
    expect(await overflow.json()).toEqual({ error: 'Too many sessions' })
    expect(server.getSessions().size).toBe(2)

    // KEEPALIVE_MS flows into the SDK transport (private field of the pinned SDK).
    const transport = server.getSessions().get(firstId)!.transport as unknown as { _keepAliveMs?: number }
    expect(transport._keepAliveMs).toBe(config.mcp.keepAliveMs)
  } finally {
    await server.stop()
  }
})
