import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { config } from '../config'
import { getDb } from '../db/container'
import { closeDb } from '../db/init'
import { setThoughtLimits } from '../db/settings'
import { registerAllMemoryTools } from '../mcp/tools'
import { createTestDb, seedThought } from '../test/helpers'
import { closeLogDb, getLogDb } from './log'

// Coverage for the telemetry cut (ADR 2026-10-21, Q1/Q5): nothing writes to
// `thought_telemetry` any more — the HTTP `withTelemetry` wrapper and the MCP
// `instrumentServer` middleware are both gone — and the table itself is dropped
// from every logs.db by the appended log migration v2.
//
// The write path and the schema are pinned separately: the second one alone
// would still pass if a writer were re-introduced against an already-dropped
// table, so the tests below re-create the table by hand (the state of a
// deployed logs.db that has not been migrated yet) and prove that a tool call
// and an HTTP request still write no row into it.
//
// The structured `logs` table is the survivor: it must keep receiving its rows
// on the very same calls.

const TMP_ROOT = '/tmp/opencode'
const THOUGHT_TELEMETRY_DDL = `
  CREATE TABLE IF NOT EXISTS thought_telemetry (
    id            TEXT PRIMARY KEY,
    correlation_id TEXT,
    user_id       TEXT,
    action        TEXT NOT NULL,
    tool_name     TEXT NOT NULL,
    prev_tool     TEXT,
    query         TEXT,
    thought_id    TEXT,
    response_size INTEGER,
    latency_ms    INTEGER,
    session_id    TEXT,
    meta          TEXT,
    created_at    TEXT NOT NULL
  )
`

/** A thought long enough to trip the soft-limit warning, which writes a log row. */
const LONG_CONTENT = 'a'.repeat(50)

let tmpRoot = ''
let originalLogDbPath = ''
let dbCounter = 0

process.env.SYNAPTOMIND_SECRET = 'test-token'

async function setupClient(): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerAllMemoryTools(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await client.connect(clientTransport)
  return client
}

function tableNames(db: { query(sql: string): { all(): unknown[] } }): string[] {
  const rows = db.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
  return rows.map(r => r.name)
}

function countRows(db: { prepare(sql: string): { get(): unknown } }, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
  return row.c
}

function logRowsByType(db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } }, type: string): number {
  const rows = db.prepare(`SELECT COUNT(*) AS c FROM logs WHERE type = ?`).all(type) as { c: number }[]
  return rows[0].c
}

beforeEach(() => {
  createTestDb()
  // A soft limit below the content length makes the create path write its
  // soft-limit warning into the logs table — the surviving log stream.
  setThoughtLimits(getDb(), 10, 1000)

  mkdirSync(TMP_ROOT, { recursive: true })
  tmpRoot = mkdtempSync(join(TMP_ROOT, 'synaptomind-telemetry-'))
  originalLogDbPath = config.logDbPath
  config.logDbPath = join(tmpRoot, `logs-${dbCounter++}.db`)
  // Drop any handle a previous suite opened on the default path.
  closeLogDb()
})

afterEach(() => {
  closeLogDb()
  config.logDbPath = originalLogDbPath
  closeDb()
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

// ── the schema ───────────────────────────────────────────────────────────────

test('the log db has no thought_telemetry table after the cut', () => {
  const db = getLogDb()
  expect(db).not.toBeNull()

  const names = tableNames(db!)
  expect(names).toContain('logs')
  expect(names).not.toContain('thought_telemetry')
})

// ── the write path ───────────────────────────────────────────────────────────

test('an MCP tool call writes no telemetry row and still writes its log row', async () => {
  const db = getLogDb()!
  // Simulate a deployed logs.db that still carries the table (pre-migration).
  db.exec(THOUGHT_TELEMETRY_DDL)
  const logsBefore = countRows(db, 'logs')

  const client = await setupClient()
  const result = await client.callTool({
    name: 'memory_store',
    arguments: { action: 'create', content: LONG_CONTENT }
  })
  expect((result as { isError?: boolean }).isError).toBeFalsy()

  expect(countRows(db, 'thought_telemetry')).toBe(0)
  // The structured log stream still receives its row.
  expect(countRows(db, 'logs')).toBeGreaterThan(logsBefore)
  expect(logRowsByType(db, 'thought')).toBeGreaterThan(0)
})

test('an HTTP request writes no telemetry row and still writes its log row', async () => {
  const db = getLogDb()!
  db.exec(THOUGHT_TELEMETRY_DDL)
  const logsBefore = countRows(db, 'logs')

  const app = (await import('../api/router')).createApp()
  const res = await app.request('/api/thoughts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ content: LONG_CONTENT })
  })
  expect(res.status).toBe(201)

  expect(countRows(db, 'thought_telemetry')).toBe(0)
  expect(countRows(db, 'logs')).toBeGreaterThan(logsBefore)
  expect(logRowsByType(db, 'thought')).toBeGreaterThan(0)
})

test('a read-only HTTP request writes no telemetry row either', async () => {
  const db = getLogDb()!
  db.exec(THOUGHT_TELEMETRY_DDL)
  const thoughtId = seedThought({ content: 'read me' })

  const app = (await import('../api/router')).createApp()
  const res = await app.request(`/api/thoughts/${thoughtId}`, {
    headers: { Authorization: 'Bearer test-token' }
  })
  expect(res.status).toBe(200)

  expect(countRows(db, 'thought_telemetry')).toBe(0)
})
