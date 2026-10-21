import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config'
import { closeDb } from '../db/init'
import { createTestDb } from '../test/helpers'
import { closeLogDb, getLogDb, insertLog, LogStore } from './log'

// Coverage for the telemetry cut (ADR 2026-10-21, Q2/Q7): the structured
// `logs` table is the survivor of the cut. It is the durable, human-readable
// audit trail (types `embedding`, `embedder`, `placement`, …) and it keeps its
// rotation. The telemetry table was a different thing: a machine-scoped
// analytics stream whose last reader died with the cut.
//
// The rotation was never covered by a test; it is pinned here because the cut
// touches the very migration that owns the log-db schema.

const TMP_ROOT = '/tmp/opencode'
const LOG_TYPES = ['embedding', 'embedder', 'placement']

let tmpRoot = ''
let originalLogDbPath = ''

beforeEach(() => {
  createTestDb()
  mkdirSync(TMP_ROOT, { recursive: true })
  tmpRoot = mkdtempSync(join(TMP_ROOT, 'synaptomind-logs-'))
  originalLogDbPath = config.logDbPath
  config.logDbPath = join(tmpRoot, 'logs.db')
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

test('the logs table still receives the embedding, embedder and placement rows', () => {
  for (const type of LOG_TYPES) {
    insertLog('info', type, `${type} row`)
  }

  const db = getLogDb()!
  const rows = db.prepare(`SELECT type, message FROM logs ORDER BY created_at`).all() as {
    type: string
    message: string
  }[]

  for (const type of LOG_TYPES) {
    expect(rows.filter(r => r.type === type).map(r => r.message)).toEqual([`${type} row`])
  }
})

test('the logs table still rotates: only the newest 5000 rows survive', () => {
  const store = new LogStore({ logDbPath: join(tmpRoot, 'rotation.db') })
  try {
    const db = store.getLogDb()!
    // Seed one row more than the cap with strictly increasing timestamps, so
    // the rotation order (created_at DESC) is deterministic.
    const seed = db.transaction(() => {
      for (let i = 0; i < 5001; i++) {
        db.prepare(
          `INSERT INTO logs (id, level, type, message, metadata, source, error, created_at)
           VALUES (?, 'info', 'seed', ?, NULL, 'synaptomind', NULL, ?)`
        ).run(`row-${i}`, `seed ${i}`, new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString())
      }
    })
    seed()

    // The cleanup runs every 100th insert (CLEANUP_INTERVAL), so 100 inserts
    // are enough to trigger it once.
    for (let i = 0; i < 100; i++) {
      store.insertLog('info', 'rotation', `rotation ${i}`)
    }

    const count = (db.prepare(`SELECT COUNT(*) AS c FROM logs`).get() as { c: number }).c
    expect(count).toBe(5000)

    const oldest = db.prepare(`SELECT id FROM logs WHERE id = 'row-0'`).get()
    expect(oldest).toBeNull()

    const newest = db.prepare(`SELECT id FROM logs WHERE id = 'row-5000'`).get()
    expect(newest).not.toBeNull()
  } finally {
    store.closeLogDb()
  }
})
