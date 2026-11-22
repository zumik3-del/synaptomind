import { afterEach, describe, expect, test } from 'bun:test'
import { SessionRegistry, type SessionRegistryOptions } from './mcp-route'

// Task #2602: the registry that replaced the inline session Map. It owns the cap decision, the
// owner-tagged counting, the TTL sweep and the shutdown drain; the transport-level 429 and the
// per-request ownership check stay with `createMcpRouteHandler` (covered by
// http-transport.limits.suite.ts and http-transport.test.ts).

const OPTIONS: SessionRegistryOptions = {
  maxSessions: 2,
  keepAliveMs: 1_000,
  maxRequestBodyBytes: 1_024,
  ttlMs: 1_000
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'session-registry-test', version: '1.0.0' }
  }
}

const created: SessionRegistry[] = []

function registry(overrides: Partial<SessionRegistryOptions> = {}): SessionRegistry {
  const reg = new SessionRegistry({ ...OPTIONS, ...overrides })
  created.push(reg)
  return reg
}

afterEach(async () => {
  await Promise.all(created.splice(0).map(reg => reg.disposeAll()))
})

function initializeRequest(): Request {
  return new Request('http://127.0.0.1/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify(INITIALIZE)
  })
}

// The registry registers a session from `onsessioninitialized`, so a session exists only after the
// transport has answered one initialize — no listener and no database involved.
async function openSession(reg: SessionRegistry, userId: string): Promise<string> {
  const pair = reg.create({ userId, kind: 'user' })
  await pair.server.connect(pair.transport)
  const res = await pair.transport.handleRequest(initializeRequest())
  const id = res.headers.get('mcp-session-id')
  await res.body?.cancel()
  if (!id) throw new Error(`initialize did not issue a session id (status ${res.status})`)
  return id
}

describe('SessionRegistry — create/get', () => {
  test('create() alone registers nothing: the session appears when the transport issues an id', async () => {
    const reg = registry()
    const pair = reg.create({ userId: 'alice', kind: 'user' })

    expect(reg.view.size).toBe(0)
    expect(reg.atCapacity('alice')).toBe(false)

    await pair.server.connect(pair.transport)
    const res = await pair.transport.handleRequest(initializeRequest())
    await res.body?.cancel()
    const id = res.headers.get('mcp-session-id')

    expect(id).toBeString()
    expect(reg.view.size).toBe(1)
    expect(reg.get(id!)?.transport).toBe(pair.transport)
  })

  test('get() returns the session it owns and undefined for an unknown id', async () => {
    const reg = registry()
    const id = await openSession(reg, 'alice')

    const session = reg.get(id)
    expect(session).toBeDefined()
    expect(session?.userId).toBe('alice')
    expect(reg.get('no-such-session')).toBeUndefined()
  })
})

describe('SessionRegistry — countForUser/atCapacity', () => {
  test('countForUser does not mix users', async () => {
    const reg = registry({ maxSessions: 5 })
    await openSession(reg, 'alice')
    await openSession(reg, 'alice')
    await openSession(reg, 'bob')

    expect(reg.countForUser('alice')).toBe(2)
    expect(reg.countForUser('bob')).toBe(1)
    expect(reg.countForUser('carol')).toBe(0)
    expect(reg.view.size).toBe(3)
  })

  test('atCapacity is per user and follows maxSessions', async () => {
    const reg = registry({ maxSessions: 2 })

    expect(reg.atCapacity('alice')).toBe(false)
    await openSession(reg, 'alice')
    expect(reg.atCapacity('alice')).toBe(false)
    await openSession(reg, 'alice')

    expect(reg.atCapacity('alice')).toBe(true)
    expect(reg.atCapacity('bob')).toBe(false)

    await openSession(reg, 'bob')
    expect(reg.countForUser('bob')).toBe(1)
    expect(reg.atCapacity('bob')).toBe(false)
  })
})

describe('SessionRegistry — dispose', () => {
  test('dispose closes and removes only that session', async () => {
    const reg = registry()
    const first = await openSession(reg, 'alice')
    const second = await openSession(reg, 'alice')
    const server = reg.get(first)!.server

    await reg.dispose(first)

    expect(reg.get(first)).toBeUndefined()
    expect(reg.get(second)).toBeDefined()
    expect(reg.view.size).toBe(1)
    expect(server.isConnected()).toBe(false)
  })

  test('dispose of an unknown id is a no-op', async () => {
    const reg = registry()
    const id = await openSession(reg, 'alice')

    await reg.dispose('no-such-session')

    expect(reg.view.size).toBe(1)
    expect(reg.get(id)).toBeDefined()
  })

  test('disposeAll drains every session (the shutdown path)', async () => {
    const reg = registry({ maxSessions: 3 })
    const first = await openSession(reg, 'alice')
    const second = await openSession(reg, 'bob')
    const third = await openSession(reg, 'bob')
    const servers = [first, second, third].map(id => reg.get(id)!.server)

    await reg.disposeAll()

    expect(reg.view.size).toBe(0)
    for (const id of [first, second, third]) expect(reg.get(id)).toBeUndefined()
    for (const server of servers) expect(server.isConnected()).toBe(false)
  })
})

describe('SessionRegistry — sweep', () => {
  test('sweep removes only expired sessions and keeps the boundary session', async () => {
    const reg = registry({ ttlMs: 1_000 })
    const expired = await openSession(reg, 'alice')
    const boundary = await openSession(reg, 'alice')
    const fresh = await openSession(reg, 'bob')

    const now = Date.now()
    reg.get(expired)!.lastAccess = now - 1_001
    reg.get(boundary)!.lastAccess = now - 1_000
    reg.get(fresh)!.lastAccess = now - 10

    reg.sweep(now)

    expect(reg.get(expired)).toBeUndefined()
    expect(reg.get(boundary)).toBeDefined()
    expect(reg.get(fresh)).toBeDefined()
    expect(reg.view.size).toBe(2)
    expect(reg.countForUser('alice')).toBe(1)
  })

  test('sweep with nothing expired leaves the registry alone', async () => {
    const reg = registry({ ttlMs: 60_000 })
    const id = await openSession(reg, 'alice')

    reg.sweep()

    expect(reg.get(id)).toBeDefined()
    expect(reg.view.size).toBe(1)
  })
})
