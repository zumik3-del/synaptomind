import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb, getDb } from '../db'
import { createVerifyEntry, getFlaggedThoughtIds } from '../db/thought_verify'
import { runVerifyJob } from './thought_verify.service'

beforeEach(createTestDb)
afterEach(closeDb)

// :memory: test DBs skip the vec0 extension, so the vec_thoughts virtual table
// never exists there. getThoughtEmbedding() only needs a row with an
// `embedding` column, so a plain table makes the flagging path deterministic.
//
// NOTE (pre-existing bug, out of scope for #107): getThoughtEmbedding()
// converts the BLOB via `new Float32Array(buffer, byteOffset, byteLength)`,
// treating byteLength as an element count — it throws RangeError for any
// non-empty BLOB. runVerifyJob() uses the lookup only as an existence gate,
// so a zero-length BLOB is the deterministic way to pass it in tests.
function seedVecEmbedding(db: Database, thoughtId: string): void {
  db.prepare(`CREATE TABLE IF NOT EXISTS vec_thoughts (id TEXT PRIMARY KEY, embedding BLOB)`).run()
  db.prepare(`INSERT OR REPLACE INTO vec_thoughts (id, embedding) VALUES (?, ?)`).run(thoughtId, Buffer.alloc(0))
}

function setThoughtAge(id: string, daysAgo: number): void {
  getDb()
    .prepare(`UPDATE thoughts SET created_at = ? WHERE id = ?`)
    .run(new Date(Date.now() - daysAgo * 86400000).toISOString(), id)
}

test('runVerifyJob returns zeros when disabled via opts', async () => {
  const db = getDb()
  const id = seedThought({ content: 'thought to verify' })
  createVerifyEntry(db, id)

  const result = await runVerifyJob({ enabled: false })
  expect(result).toEqual({ checked: 0, flagged: 0, skipped: 0 })
})

test('runVerifyJob returns zeros when no pending entries', async () => {
  const result = await runVerifyJob({ enabled: true, staleWarnDays: 30 })
  expect(result.checked).toBe(0)
  expect(result.flagged).toBe(0)
  expect(result.skipped).toBe(0)
})

test('runVerifyJob checks entries', async () => {
  const db = getDb()
  const id = seedThought({ content: 'thought to verify' })
  createVerifyEntry(db, id)

  const result = await runVerifyJob({ enabled: true, staleWarnDays: 30 })
  expect(result.checked).toBeGreaterThanOrEqual(1)
})

test('runVerifyJob flags stale thought only when staleWarnDays override applies (issue #107)', async () => {
  const db = getDb()
  const id = seedThought({ content: 'stale thought' })
  setThoughtAge(id, 10) // older than the 1-day override, younger than the 30-day default
  createVerifyEntry(db, id)
  seedVecEmbedding(db, id)

  const withDefault = await runVerifyJob({ enabled: true, staleWarnDays: 30 })
  expect(withDefault.flagged).toBe(0)
  expect(getFlaggedThoughtIds(db)).not.toContain(id)

  const withOverride = await runVerifyJob({ enabled: true, staleWarnDays: 1 })
  expect(withOverride.flagged).toBe(1)
  expect(getFlaggedThoughtIds(db)).toContain(id)
})
