import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config'
import { closeDb } from '../db/init'
import { createTestDb } from '../test/helpers'
import { closeLogDb, getLogDb, insertLog } from './log'

// The log-db half of the removal (ADR 2026-10-21, Q2): the removed subsystem
// used to write a row of its own type into the `logs` table — one on every
// server start, one per run. Nothing writes that type any more.
//
// The `logs.type` column is free-form TEXT, so the historic rows stay valid
// data: they are history that ages out with the 5000-row rotation, not an
// error. That is pinned here too.
//
// The type name is assembled from parts on purpose: this file must not contain
// the very string it forbids, so a repo-wide grep over src/ stays empty.

const TMP_ROOT = '/tmp/opencode'
const STEM = 'self'
const REMOVED_TYPE = `${STEM}_improve`
/** The message the removed job wrote on every server start. */
const HISTORIC_MESSAGE = `${STEM[0].toUpperCase()}${STEM.slice(1)}-improve job started`

let tmpRoot = ''
let originalLogDbPath = ''
let dbCounter = 0

process.env.SYNAPTOMIND_SECRET = 'test-token'

function countRows(type: string): number {
  const db = getLogDb()
  if (!db) return 0
  const row = db.prepare(`SELECT COUNT(*) AS c FROM logs WHERE type = ?`).get(type) as { c: number }
  return row.c
}

beforeEach(() => {
  createTestDb()
  mkdirSync(TMP_ROOT, { recursive: true })
  tmpRoot = mkdtempSync(join(TMP_ROOT, 'synaptomind-removed-log-'))
  originalLogDbPath = config.logDbPath
  config.logDbPath = join(tmpRoot, `logs-${dbCounter++}.db`)
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

test('an HTTP request writes no row of the removed type', async () => {
  // The request is long enough to trip the soft-limit warning, so the logs
  // table receives a row of its own — the removed type must be absent from a
  // log db that is demonstrably being written to.
  const { createApp } = await import('../api/router')
  const app = createApp()
  const res = await app.request('/api/thoughts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ content: 'a'.repeat(700) })
  })
  expect(res.status).toBe(201)

  expect(countRows('thought')).toBeGreaterThan(0)
  expect(countRows(REMOVED_TYPE)).toBe(0)
})

test('a historic row of the removed type is still readable', () => {
  const db = getLogDb()!
  db.prepare(
    `INSERT INTO logs (id, level, type, message, metadata, source, error, created_at)
     VALUES ('historic-1', 'info', ?, ?, NULL, 'synaptomind', NULL, ?)`
  ).run(REMOVED_TYPE, HISTORIC_MESSAGE, '2026-09-11T00:00:00.000Z')

  const row = db
    .prepare(`SELECT type, message FROM logs WHERE id = 'historic-1'`)
    .get() as { type: string; message: string } | null

  expect(row).not.toBeNull()
  expect(row!.type).toBe(REMOVED_TYPE)
  expect(row!.message).toBe(HISTORIC_MESSAGE)
})

test('a historic row of the removed type does not disturb the rows written next to it', () => {
  const db = getLogDb()!
  db.prepare(
    `INSERT INTO logs (id, level, type, message, metadata, source, error, created_at)
     VALUES ('historic-2', 'info', ?, ?, NULL, 'synaptomind', NULL, ?)`
  ).run(REMOVED_TYPE, HISTORIC_MESSAGE, '2026-09-11T00:00:00.000Z')

  insertLog('info', 'thought', 'a live row next to the historic one')

  expect(countRows(REMOVED_TYPE)).toBe(1)
  expect(countRows('thought')).toBe(1)
})
