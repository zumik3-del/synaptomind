import { beforeAll, afterAll, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { openDatabase } from '../db/init'
import { clearDb, clearRegistry, register } from '../db/container'
import { config, hashUserToken } from '../config'
import { upsertSlot } from '../db/slots'

const ALICE_TOKEN = 'alice-token'
const BOB_TOKEN = 'bob-token'
const CHARLIE_TOKEN = 'charlie-token'
const LEGACY_SECRET = 'legacy-secret-hijack'
const PROTOCOL_VERSION = '2025-06-18'
const INIT_MESSAGE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'hijack-suite', version: '1.0.0' }
  }
}
const LIST_MESSAGE = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }

let dbA: Database
let dbB: Database

// Lazy import to allow env setup first.
let startMcpHttpServer: any
let freePort: () => Promise<number>

function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra }
}

async function initFreePort() {
  freePort = async () => {
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') })
    const port = probe.port
    await probe.stop(true)
    if (port === undefined) throw new Error('no port')
    return port
  }
}

async function initialize(base: string, token: string): Promise<string> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: authHeaders(token, {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    }),
    body: JSON.stringify(INIT_MESSAGE)
  })
  const id = res.headers.get('mcp-session-id')
  await res.body?.cancel()
  if (!id) throw new Error(`initialize failed (status ${res.status})`)
  return id
}

function destroy(base: string, token: string, sessionId: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'DELETE',
    headers: authHeaders(token, { 'mcp-session-id': sessionId })
  })
}

async function parseRpc(res: Response): Promise<any> {
  const text = await res.text()
  try { return JSON.parse(text) } catch {}
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      try { return JSON.parse(line.slice(5).trim()) } catch {}
    }
  }
  return text
}

async function toolCall(base: string, token: string, sessionId: string, args: any): Promise<{ status: number; rpc: any }> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: authHeaders(token, {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId
    }),
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'memory_status', arguments: args } })
  })
  const rpc = await parseRpc(res)
  return { status: res.status, rpc }
}

beforeAll(async () => {
  await initFreePort()
  const mod = await import('./http-transport')
  startMcpHttpServer = mod.startMcpHttpServer

  // Multi-user config: three users, charlie has no registered DB (503 case).
  config.users = [
    { id: 'alice', dbPath: '/tmp/alice-hijack.db', tokenSha256: hashUserToken(ALICE_TOKEN) },
    { id: 'bob', dbPath: '/tmp/bob-hijack.db', tokenSha256: hashUserToken(BOB_TOKEN) },
    { id: 'charlie', dbPath: '/tmp/charlie-hijack.db', tokenSha256: hashUserToken(CHARLIE_TOKEN) }
  ]

  clearRegistry()
  dbA = openDatabase({ dbPath: ':memory:', runMigrations: true })
  // openDatabase set global db to dbA; create second without clobbering? We'll just register both.
  register('alice', dbA)
  // Need a separate migrated DB for bob: reopen via openDatabase.
  dbB = openDatabase({ dbPath: ':memory:', runMigrations: true })
  register('bob', dbB)
  // restore global not strictly needed for multi-user path

  // Seed distinct slot content for isolation proof.
  upsertSlot(dbA, { name: 'project_context', scope: 'global', scope_id: null, content: 'ALICE-PCTX', max_chars: 2000 })
  upsertSlot(dbB, { name: 'project_context', scope: 'global', scope_id: null, content: 'BOB-PCTX', max_chars: 2000 })
})

afterAll(() => {
  // best-effort cleanup
})

describe('hijack matrix (multi-user)', () => {
  test('POST/GET/DELETE with a different token returns 403 and leaves the session intact', async () => {
    const port = await freePort()
    const server = startMcpHttpServer('127.0.0.1', port)
    const base = `http://127.0.0.1:${port}`
    try {
      const aliceSession = await initialize(base, ALICE_TOKEN)
      const beforeSize = server.getSessions().size

      // POST
      const postRes = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: authHeaders(BOB_TOKEN, {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': aliceSession
        }),
        body: JSON.stringify(LIST_MESSAGE)
      })
      expect(postRes.status).toBe(403)
      const postBody = await postRes.json() as any
      expect(postBody.error.code).toBe(-32002)
      expect(server.getSessions().has(aliceSession)).toBe(true)

      // GET (SSE attach)
      const getRes = await fetch(`${base}/mcp`, {
        method: 'GET',
        headers: authHeaders(BOB_TOKEN, {
          accept: 'text/event-stream',
          'mcp-session-id': aliceSession
        })
      })
      expect(getRes.status).toBe(403)
      await getRes.body?.cancel()
      expect(server.getSessions().has(aliceSession)).toBe(true)

      // DELETE
      const delRes = await fetch(`${base}/mcp`, {
        method: 'DELETE',
        headers: authHeaders(BOB_TOKEN, { 'mcp-session-id': aliceSession })
      })
      expect(delRes.status).toBe(403)
      expect(server.getSessions().has(aliceSession)).toBe(true)
      expect(server.getSessions().size).toBe(beforeSize)

      await destroy(base, ALICE_TOKEN, aliceSession)
    } finally {
      await server.stop()
    }
  })

  test('per-user isolation through a real tool (memory_status slots)', async () => {
    const port = await freePort()
    const server = startMcpHttpServer('127.0.0.1', port)
    const base = `http://127.0.0.1:${port}`
    try {
      const aSession = await initialize(base, ALICE_TOKEN)
      const bSession = await initialize(base, BOB_TOKEN)

      const a = await toolCall(base, ALICE_TOKEN, aSession, { action: 'slots', cwd: '/tmp', names: ['project_context'] })
      expect(a.status).toBe(200)
      const aSlot = extractSlot(a.rpc, 'project_context')
      expect(aSlot.content).toContain('ALICE-PCTX')
      expect(aSlot.content).not.toContain('BOB-PCTX')

      const b = await toolCall(base, BOB_TOKEN, bSession, { action: 'slots', cwd: '/tmp', names: ['project_context'] })
      expect(b.status).toBe(200)
      const bSlot = extractSlot(b.rpc, 'project_context')
      expect(bSlot.content).toContain('BOB-PCTX')
      expect(bSlot.content).not.toContain('ALICE-PCTX')

      await destroy(base, ALICE_TOKEN, aSession)
      await destroy(base, BOB_TOKEN, bSession)
    } finally {
      await server.stop()
    }
  })

  test('interleaved A/B/A keeps per-user data isolated', async () => {
    const port = await freePort()
    const server = startMcpHttpServer('127.0.0.1', port)
    const base = `http://127.0.0.1:${port}`
    try {
      const aSession = await initialize(base, ALICE_TOKEN)
      const bSession = await initialize(base, BOB_TOKEN)

      const r1 = await toolCall(base, ALICE_TOKEN, aSession, { action: 'slots', cwd: '/tmp', names: ['project_context'] })
      const s1 = extractSlot(r1.rpc, 'project_context')
      expect(s1.content).toContain('ALICE-PCTX')

      const r2 = await toolCall(base, BOB_TOKEN, bSession, { action: 'slots', cwd: '/tmp', names: ['project_context'] })
      const s2 = extractSlot(r2.rpc, 'project_context')
      expect(s2.content).toContain('BOB-PCTX')

      const r3 = await toolCall(base, ALICE_TOKEN, aSession, { action: 'slots', cwd: '/tmp', names: ['project_context'] })
      const s3 = extractSlot(r3.rpc, 'project_context')
      expect(s3.content).toContain('ALICE-PCTX')
      expect(s3.content).not.toContain('BOB-PCTX')

      await destroy(base, ALICE_TOKEN, aSession)
      await destroy(base, BOB_TOKEN, bSession)
    } finally {
      await server.stop()
    }
  })

  test('503 fail-closed when the resolved user has no registered DB', async () => {
    const port = await freePort()
    const server = startMcpHttpServer('127.0.0.1', port)
    const base = `http://127.0.0.1:${port}`
    try {
      const before = server.getSessions().size
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: authHeaders(CHARLIE_TOKEN, {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream'
        }),
        body: JSON.stringify(INIT_MESSAGE)
      })
      expect(res.status).toBe(503)
      await res.body?.cancel()
      expect(server.getSessions().size).toBe(before)
    } finally {
      await server.stop()
    }
  })
})

describe('legacy single-user regression', () => {
  test('legacy mode: initialize + tool call still work', async () => {
    // Switch to legacy mode.
    config.users = []
    clearRegistry()
    // set a global db
    const { createTestDb } = await import('../test/helpers')
    createTestDb()

    // set secret
    process.env.SYNAPTOMIND_SECRET = LEGACY_SECRET

    const port = await freePort()
    const server = startMcpHttpServer('127.0.0.1', port)
    const base = `http://127.0.0.1:${port}`
    try {
      const session = await initialize(base, LEGACY_SECRET)
      const r = await toolCall(base, LEGACY_SECRET, session, { action: 'slots', cwd: '/tmp' })
      expect(r.status).toBe(200)
      await destroy(base, LEGACY_SECRET, session)
    } finally {
      await server.stop()
    }
  })

  test('legacy mode can initialize with an unavailable database', async () => {
    config.users = []
    clearRegistry()
    clearDb()
    process.env.SYNAPTOMIND_SECRET = LEGACY_SECRET

    const port = await freePort()
    const server = startMcpHttpServer('127.0.0.1', port)
    const base = `http://127.0.0.1:${port}`
    try {
      const session = await initialize(base, LEGACY_SECRET)
      expect(server.getSessions().has(session)).toBe(true)
      await destroy(base, LEGACY_SECRET, session)
    } finally {
      await server.stop()
    }
  })
})

function extractSlot(rpc: any, name: string): any {
  // rpc is JSON-RPC response; tool result content[0].text holds envelope JSON
  let envelope: any = null
  try {
    const text = rpc?.result?.content?.[0]?.text
    if (typeof text === 'string') envelope = JSON.parse(text)
  } catch {}
  if (!envelope) {
    // maybe structuredContent
    try { envelope = rpc?.result?.structuredContent?.result } catch {}
  }
  const items = envelope?.items ?? envelope?.result?.items
  const slot = (items ?? []).find((s: any) => s.name === name)
  if (!slot) throw new Error(`slot ${name} not found in ${JSON.stringify(rpc).slice(0, 500)}`)
  return slot
}
