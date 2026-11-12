import { beforeAll, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { openDatabase } from '../db/init'
import { clearRegistry, register } from '../context/container'
import { config, hashUserToken } from '../config'
import { upsertSlot } from '../db/slots'
import type { McpHttpHandle } from './http-transport'

// Modern-era per-user containment (task #2436, T-mod-2/3, T-neg-5). The
// 2026-07-28 leg keeps no session to bind, so the proof is the data plane: each
// envelope tools/call must resolve the caller's own database through the ALS
// binding, and a legacy session id must still be refused across users.
const ALICE_TOKEN = 'alice-modern-token'
const BOB_TOKEN = 'bob-modern-token'
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
    clientInfo: { name: 'modern-isolation-suite', version: '1.0.0' }
  }
}
const LIST_MESSAGE = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }

let dbA: Database
let dbB: Database

let startMcpHttpServer: (host: string, port: number) => McpHttpHandle

function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra }
}

function modernHeaders(
  token: string,
  method: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  return authHeaders(token, {
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

async function modernToolCall(
  base: string,
  token: string,
  name: string,
  args: Record<string, unknown>
): Promise<{ status: number; body: any; sessionId: string | null }> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: modernHeaders(token, 'tools/call', { 'mcp-name': name }),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name, arguments: args, _meta: ENVELOPE }
    })
  })
  return {
    status: res.status,
    body: await res.json(),
    sessionId: res.headers.get('mcp-session-id')
  }
}

async function initializeLegacy(base: string, token: string): Promise<string> {
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

function slots(base: string, token: string) {
  return modernToolCall(base, token, 'memory_status', {
    action: 'slots',
    cwd: '/tmp',
    names: ['project_context']
  })
}

function extractSlot(body: any, name: string): any {
  const items = body?.result?.structuredContent?.result?.items ?? []
  const slot = items.find((item: any) => item.name === name)
  if (!slot) throw new Error(`slot ${name} not found in ${JSON.stringify(body).slice(0, 500)}`)
  return slot
}

beforeAll(async () => {
  const mod = await import('./http-transport')
  startMcpHttpServer = mod.startMcpHttpServer

  config.users = [
    { id: 'alice', dbPath: '/tmp/alice-modern.db', tokenSha256: hashUserToken(ALICE_TOKEN) },
    { id: 'bob', dbPath: '/tmp/bob-modern.db', tokenSha256: hashUserToken(BOB_TOKEN) }
  ]

  clearRegistry()
  dbA = openDatabase({ dbPath: ':memory:', runMigrations: true })
  register('alice', dbA)
  dbB = openDatabase({ dbPath: ':memory:', runMigrations: true })
  register('bob', dbB)

  upsertSlot(dbA, {
    name: 'project_context',
    scope: 'global',
    scope_id: null,
    content: 'ALICE-PCTX',
    max_chars: 2000
  })
  upsertSlot(dbB, {
    name: 'project_context',
    scope: 'global',
    scope_id: null,
    content: 'BOB-PCTX',
    max_chars: 2000
  })
})

describe('modern era, multi-user', () => {
  test('T-mod-2: envelope tools/call reads the caller database on both users', async () => {
    const port = await freePort()
    const server = startMcpHttpServer('127.0.0.1', port)
    const base = `http://127.0.0.1:${port}`
    try {
      const a = await slots(base, ALICE_TOKEN)
      expect(a.status).toBe(200)
      expect(a.sessionId).toBeNull()
      expect(extractSlot(a.body, 'project_context').content).toBe('ALICE-PCTX')

      const b = await slots(base, BOB_TOKEN)
      expect(b.status).toBe(200)
      expect(extractSlot(b.body, 'project_context').content).toBe('BOB-PCTX')
    } finally {
      await server.stop()
    }
  })

  test('T-mod-3: memory_store over the modern leg writes only the caller database', async () => {
    const port = await freePort()
    const server = startMcpHttpServer('127.0.0.1', port)
    const base = `http://127.0.0.1:${port}`
    try {
      const created = await modernToolCall(base, ALICE_TOKEN, 'memory_store', {
        action: 'create',
        content: 'MODERN-ALPHA',
        cwd: '/tmp'
      })
      expect(created.status).toBe(200)
      expect(created.sessionId).toBeNull()
      const item = created.body.result.structuredContent.result.item
      expect(item.content).toBe('MODERN-ALPHA')

      expect(rowsWithContent(dbA, 'MODERN-ALPHA')).toBe(1)
      expect(rowsWithContent(dbB, 'MODERN-ALPHA')).toBe(0)

      const bobCreated = await modernToolCall(base, BOB_TOKEN, 'memory_store', {
        action: 'create',
        content: 'MODERN-BETA',
        cwd: '/tmp'
      })
      expect(bobCreated.status).toBe(200)
      expect(rowsWithContent(dbB, 'MODERN-BETA')).toBe(1)
      expect(rowsWithContent(dbA, 'MODERN-BETA')).toBe(0)
    } finally {
      await server.stop()
    }
  })
})

describe('cross-user containment (T-neg-5)', () => {
  test('a foreign session id is 403 and the victim session stays intact', async () => {
    const port = await freePort()
    const server = startMcpHttpServer('127.0.0.1', port)
    const base = `http://127.0.0.1:${port}`
    try {
      const aliceSession = await initializeLegacy(base, ALICE_TOKEN)

      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: authHeaders(BOB_TOKEN, {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': aliceSession
        }),
        body: JSON.stringify(LIST_MESSAGE)
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as any
      expect(body.error.code).toBe(-32002)

      expect(server.getSessions().has(aliceSession)).toBe(true)
      expect(server.getSessions().get(aliceSession)!.userId).toBe('alice')

      const unknown = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: authHeaders(ALICE_TOKEN, {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': 'no-such-session'
        }),
        body: JSON.stringify(LIST_MESSAGE)
      })
      expect(unknown.status).toBe(404)
      expect(((await unknown.json()) as any).error.code).toBe(-32001)
    } finally {
      await server.stop()
    }
  })
})

function rowsWithContent(db: Database, content: string): number {
  const row = db.query('SELECT COUNT(*) AS n FROM thoughts WHERE content = ?').get(content) as {
    n: number
  }
  return row.n
}
