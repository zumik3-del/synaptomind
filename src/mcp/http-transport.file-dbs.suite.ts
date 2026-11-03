import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashUserToken, config } from '../config'
import { clearRegistry, register } from '../db/container'
import { openDatabase } from '../db/init'
import { upsertSlot } from '../db/slots'

// Task #2299: the hijack suite proves the session↔user matrix against
// per-user `:memory:` instances. This suite repeats the end-to-end shape on the
// production layout instead — two REAL migrated database FILES, two real MCP
// HTTP clients with distinct bearer tokens, interleaved requests — and then
// reads the files back to show the routing wrote and read the right one.
//
// MCP is stateless per request in this transport; the bearer token, not the
// session id, decides the database, and a foreign token can neither attach to
// nor delete another user's session.

const ALICE_TOKEN = 'file-db-alice-token'
const BOB_TOKEN = 'file-db-bob-token'
const PROTOCOL_VERSION = '2025-06-18'
const INIT_MESSAGE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'file-db-suite', version: '1.0.0' }
  }
}

const root = mkdtempSync(join(tmpdir(), 'synaptomind-http-files-'))
const alicePath = join(root, 'alice.db')
const bobPath = join(root, 'bob.db')

let dbAlice: Database
let dbBob: Database
let startMcpHttpServer: typeof import('./http-transport').startMcpHttpServer

function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra }
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') })
  const port = probe.port
  await probe.stop(true)
  if (port === undefined) throw new Error('no port')
  return port
}

async function initialize(base: string, token: string): Promise<string> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: authHeaders(token, { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }),
    body: JSON.stringify(INIT_MESSAGE)
  })
  const id = res.headers.get('mcp-session-id')
  await res.body?.cancel()
  if (!id) throw new Error(`initialize failed (status ${res.status})`)
  return id
}

async function destroy(base: string, token: string, sessionId: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'DELETE',
    headers: authHeaders(token, { 'mcp-session-id': sessionId })
  })
}

async function parseRpc(res: Response): Promise<any> {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {}
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      try {
        return JSON.parse(line.slice(5).trim())
      } catch {}
    }
  }
  return text
}

async function callTool(
  base: string,
  token: string,
  sessionId: string,
  name: string,
  args: Record<string, unknown>
): Promise<{ status: number; rpc: any }> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: authHeaders(token, {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId
    }),
    body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name, arguments: args } })
  })
  const rpc = await parseRpc(res)
  return { status: res.status, rpc }
}

async function readSlot(base: string, token: string, sessionId: string): Promise<any> {
  const { rpc } = await callTool(base, token, sessionId, 'memory_status', {
    action: 'slots',
    cwd: '/tmp',
    names: ['project_context']
  })
  const text = rpc?.result?.content?.[0]?.text
  const envelope = typeof text === 'string' ? JSON.parse(text) : rpc?.result?.structuredContent?.result
  const items = envelope?.items ?? envelope?.result?.items ?? []
  const slot = (items as Array<{ name: string; content: string }>).find(s => s.name === 'project_context')
  if (!slot) throw new Error(`slot not found in ${JSON.stringify(rpc).slice(0, 400)}`)
  return slot
}

function thoughtContent(path: string, marker: string): number {
  const db = new Database(path, { readonly: true })
  try {
    const row = db
      .query('SELECT count(*) AS n FROM thoughts WHERE content LIKE ?')
      .get(`%${marker}%`) as { n: number }
    return row.n
  } finally {
    db.close()
  }
}

function fileSlotContent(path: string): string {
  const db = new Database(path, { readonly: true })
  try {
    const row = db.query("SELECT content FROM slots WHERE name = 'project_context'").get() as
      | { content: string }
      | undefined
    if (!row) throw new Error(`no project_context slot in ${path}`)
    return row.content
  } finally {
    db.close()
  }
}

beforeAll(async () => {
  // One session per user is enough here, and a cap of 1 makes the per-user
  // limit testable without opening a hundred sessions.
  config.mcp.maxSessions = 1
  startMcpHttpServer = (await import('./http-transport')).startMcpHttpServer

  config.users = [
    { id: 'alice', dbPath: alicePath, tokenSha256: hashUserToken(ALICE_TOKEN) },
    { id: 'bob', dbPath: bobPath, tokenSha256: hashUserToken(BOB_TOKEN) }
  ]

  clearRegistry()
  dbAlice = openDatabase({ dbPath: alicePath, runMigrations: true })
  register('alice', dbAlice)
  dbBob = openDatabase({ dbPath: bobPath, runMigrations: true })
  register('bob', dbBob)

  upsertSlot(dbAlice, {
    name: 'project_context',
    scope: 'global',
    scope_id: null,
    content: 'ALICE-FILE-MARKER',
    max_chars: 2000
  })
  upsertSlot(dbBob, {
    name: 'project_context',
    scope: 'global',
    scope_id: null,
    content: 'BOB-FILE-MARKER',
    max_chars: 2000
  })
})

afterAll(() => {
  try {
    dbAlice?.close(true)
  } catch {}
  try {
    dbBob?.close(true)
  } catch {}
  clearRegistry()
  rmSync(root, { recursive: true, force: true })
})

describe('multi-user isolation over real database files', () => {
  test('interleaved tokens read their own file and a foreign token cannot terminate or replay a session', async () => {
    const port = await freePort()
    const server = startMcpHttpServer('127.0.0.1', port)
    const base = `http://127.0.0.1:${port}`
    try {
      const aliceSession = await initialize(base, ALICE_TOKEN)
      const bobSession = await initialize(base, BOB_TOKEN)
      expect(aliceSession).not.toBe(bobSession)

      // A/B/A interleaving: every request re-resolves identity through the
      // bearer token, so no response may carry the other file's marker.
      const a1 = await readSlot(base, ALICE_TOKEN, aliceSession)
      expect(a1.content).toContain('ALICE-FILE-MARKER')
      expect(a1.content).not.toContain('BOB-FILE-MARKER')

      const b1 = await readSlot(base, BOB_TOKEN, bobSession)
      expect(b1.content).toContain('BOB-FILE-MARKER')
      expect(b1.content).not.toContain('ALICE-FILE-MARKER')

      const a2 = await readSlot(base, ALICE_TOKEN, aliceSession)
      expect(a2.content).toContain('ALICE-FILE-MARKER')

      // Replay/terminate with the wrong token: POST is rejected and DELETE
      // cannot kill the victim's session.
      const replay = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: authHeaders(BOB_TOKEN, {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': aliceSession
        }),
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} })
      })
      expect(replay.status).toBe(403)
      await replay.body?.cancel()
      expect(server.getSessions().has(aliceSession)).toBe(true)

      const del = await destroy(base, BOB_TOKEN, aliceSession)
      expect(del.status).toBe(403)
      await del.body?.cancel()
      expect(server.getSessions().has(aliceSession)).toBe(true)

      const stillAlice = await readSlot(base, ALICE_TOKEN, aliceSession)
      expect(stillAlice.content).toContain('ALICE-FILE-MARKER')

      const aliceClose = await destroy(base, ALICE_TOKEN, aliceSession)
      expect(aliceClose.status).toBe(200)
      await aliceClose.body?.cancel()
      const bobClose = await destroy(base, BOB_TOKEN, bobSession)
      expect(bobClose.status).toBe(200)
      await bobClose.body?.cancel()
    } finally {
      await server.stop()
    }
  })

  test('the files themselves stayed isolated: one marker each, no cross-write', () => {
    expect(fileSlotContent(alicePath)).toContain('ALICE-FILE-MARKER')
    expect(fileSlotContent(alicePath)).not.toContain('BOB-FILE-MARKER')
    expect(fileSlotContent(bobPath)).toContain('BOB-FILE-MARKER')
    expect(fileSlotContent(bobPath)).not.toContain('ALICE-FILE-MARKER')
  })

  test('a write through one token lands only in that user\'s file and is invisible to the other', async () => {
    const port = await freePort()
    const server = startMcpHttpServer('127.0.0.1', port)
    const base = `http://127.0.0.1:${port}`
    try {
      const aliceSession = await initialize(base, ALICE_TOKEN)
      const bobSession = await initialize(base, BOB_TOKEN)

      const created = await callTool(base, ALICE_TOKEN, aliceSession, 'memory_store', {
        action: 'create',
        content: 'ALICE-WRITE-MARKER',
        cwd: '/tmp'
      })
      expect(created.status).toBe(200)
      const text = created.rpc?.result?.content?.[0]?.text
      const envelope = typeof text === 'string' ? JSON.parse(text) : created.rpc?.result?.structuredContent?.result
      const thoughtId = envelope?.item?.id ?? envelope?.result?.item?.id
      expect(thoughtId).toBeTruthy()

      // The write is on disk under alice only.
      expect(thoughtContent(alicePath, 'ALICE-WRITE-MARKER')).toBe(1)
      expect(thoughtContent(bobPath, 'ALICE-WRITE-MARKER')).toBe(0)

      // Bob cannot read alice's thought even with the exact id...
      const stolen = await callTool(base, BOB_TOKEN, bobSession, 'memory_recall', {
        action: 'get',
        thought_id: thoughtId
      })
      expect(JSON.stringify(stolen.rpc)).not.toContain('ALICE-WRITE-MARKER')

      // ...while alice can.
      const own = await callTool(base, ALICE_TOKEN, aliceSession, 'memory_recall', {
        action: 'get',
        thought_id: thoughtId
      })
      expect(JSON.stringify(own.rpc)).toContain('ALICE-WRITE-MARKER')

      await (await destroy(base, ALICE_TOKEN, aliceSession)).body?.cancel()
      await (await destroy(base, BOB_TOKEN, bobSession)).body?.cancel()
    } finally {
      await server.stop()
    }
  })

  test('the session cap is per user: exhausting it for one user leaves the other usable', async () => {
    const port = await freePort()
    const server = startMcpHttpServer('127.0.0.1', port)
    const base = `http://127.0.0.1:${port}`
    try {
      // maxSessions is 1 for this suite (see beforeAll).
      await initialize(base, ALICE_TOKEN)

      const overflow = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: authHeaders(ALICE_TOKEN, {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream'
        }),
        body: JSON.stringify(INIT_MESSAGE)
      })
      expect(overflow.status).toBe(429)
      await overflow.body?.cancel()

      // A global cap would refuse bob here; a per-user cap must not.
      const bobSession = await initialize(base, BOB_TOKEN)
      expect(bobSession).toBeTruthy()
      expect(server.getSessions().size).toBe(2)
    } finally {
      await server.stop()
    }
  })
})
