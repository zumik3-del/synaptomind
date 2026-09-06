import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb, getDb } from '../db'
import {
  createVerifyEntry,
  getFlaggedThoughtIds,
  getVerifyEntries,
  getVerifyEntryByThoughtId
} from '../db/thought_verify'
import { runVerifyJob } from './thought_verify.service'

beforeEach(createTestDb)
afterEach(closeDb)

// :memory: test DBs skip the vec0 extension, so the vec_thoughts virtual table
// never exists there. getThoughtEmbedding() only needs a row with an
// `embedding` BLOB column (read as byteLength/4 Float32 elements), so a plain
// table with real float data makes the drift path deterministic.
function seedVecEmbedding(db: Database, thoughtId: string, vector: number[] = [1, 0, 0]): void {
  db.prepare(`CREATE TABLE IF NOT EXISTS vec_thoughts (id TEXT PRIMARY KEY, embedding BLOB)`).run()
  const f32 = new Float32Array(vector)
  db.prepare(`INSERT OR REPLACE INTO vec_thoughts (id, embedding) VALUES (?, ?)`).run(
    thoughtId,
    Buffer.from(f32.buffer as ArrayBuffer, f32.byteOffset, f32.byteLength)
  )
}

function setThoughtAge(id: string, daysAgo: number): void {
  getDb()
    .prepare(`UPDATE thoughts SET created_at = ? WHERE id = ?`)
    .run(new Date(Date.now() - daysAgo * 86400000).toISOString(), id)
}

function getThoughtContentHash(db: Database, thoughtId: string): string | null {
  const row = db.prepare(`SELECT content_hash FROM thoughts WHERE id = ?`).get(thoughtId) as
    | { content_hash: string | null }
    | undefined
  return row?.content_hash ?? null
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

  // recordCheck stamps last_checked, so the entry leaves the pending queue
  // until the re-check cadence elapses — reset it to simulate the next check.
  db.prepare(`UPDATE thought_verify SET last_checked = NULL WHERE thought_id = ?`).run(id)

  const withOverride = await runVerifyJob({ enabled: true, staleWarnDays: 1 })
  expect(withOverride.flagged).toBe(1)
  expect(getFlaggedThoughtIds(db)).toContain(id)
})

test('runVerifyJob records zero drift and content hash when embed matches the stored vector', async () => {
  const db = getDb()
  const id = seedThought({ content: 'stable thought' })
  seedVecEmbedding(db, id, [1, 0, 0])
  db.prepare(`UPDATE thoughts SET content_hash = ? WHERE id = ?`).run('hash-abc123', id)

  const result = await runVerifyJob({
    enabled: true,
    staleWarnDays: 30,
    embed: async () => new Float32Array([1, 0, 0])
  })

  expect(result.flagged).toBe(0)
  expect(getFlaggedThoughtIds(db)).not.toContain(id)
  const entry = getVerifyEntryByThoughtId(db, id)
  expect(entry?.last_distance).toBeCloseTo(0, 5)
  expect(entry?.last_checked).not.toBeNull()
  expect(entry?.content_hash).toBe(getThoughtContentHash(db, id))
  expect(entry?.content_hash).toBe('hash-abc123')
})

test('runVerifyJob flags when drift exceeds the default threshold', async () => {
  const db = getDb()
  const id = seedThought({ content: 'drifted thought' })
  seedVecEmbedding(db, id, [1, 0, 0])

  const result = await runVerifyJob({
    enabled: true,
    staleWarnDays: 30,
    embed: async () => new Float32Array([0, 1, 0]) // orthogonal → distance 1 > 0.25
  })

  expect(result.flagged).toBe(1)
  expect(getFlaggedThoughtIds(db)).toContain(id)
  const entry = getVerifyEntryByThoughtId(db, id)
  expect(entry?.flagged).toBe(1)
  expect(entry?.last_distance).toBeCloseTo(1, 5)
})

test('runVerifyJob falls back to staleness-only when embedding length mismatches', async () => {
  const db = getDb()
  const id = seedThought({ content: 'dimension changed' })
  seedVecEmbedding(db, id, [1, 0, 0])

  const result = await runVerifyJob({
    enabled: true,
    staleWarnDays: 30,
    embed: async () => new Float32Array([1, 0, 0, 0]) // 4 dims vs 3 stored → drift undefined
  })

  expect(result.flagged).toBe(0)
  expect(getFlaggedThoughtIds(db)).not.toContain(id)
  const entry = getVerifyEntryByThoughtId(db, id)
  expect(entry?.last_distance).toBeNull()
  // drift was never computed → content hash must not be touched
  expect(entry?.content_hash).toBeNull()
})

test('runVerifyJob survives a throwing embed fn and keeps the staleness-only path', async () => {
  const db = getDb()
  const id = seedThought({ content: 'embedder broke' })
  seedVecEmbedding(db, id, [1, 0, 0])

  const result = await runVerifyJob({
    enabled: true,
    staleWarnDays: 30,
    embed: async () => {
      throw new Error('embedder exploded')
    }
  })

  expect(result.flagged).toBe(0)
  expect(result.checked).toBe(1)
  expect(getFlaggedThoughtIds(db)).not.toContain(id)
  const entry = getVerifyEntryByThoughtId(db, id)
  expect(entry?.last_distance).toBeNull()
  expect(entry?.content_hash).toBeNull()
})

test('runVerifyJob arms verify entries for embedded thoughts without one', async () => {
  const db = getDb()
  const armed = seedThought({ content: 'has a vec row' })
  seedVecEmbedding(db, armed)
  const bare = seedThought({ content: 'no vec row' })

  await runVerifyJob({ enabled: true, staleWarnDays: 30 })

  const entry = getVerifyEntryByThoughtId(db, armed)
  expect(entry).toBeDefined()
  expect(entry?.drift_threshold).toBeCloseTo(0.25, 5)
  // thoughts without a vec_thoughts row are not armed
  expect(getVerifyEntryByThoughtId(db, bare)).toBeNull()

  // re-running must not duplicate the entry
  await runVerifyJob({ enabled: true, staleWarnDays: 30 })
  const entries = getVerifyEntries(db).filter(e => e.thought_id === armed)
  expect(entries).toHaveLength(1)
})

test('runVerifyJob works without any embedder and still flags stale thoughts', async () => {
  const db = getDb()
  const id = seedThought({ content: 'old unverified thought' })
  setThoughtAge(id, 10)
  seedVecEmbedding(db, id) // arms the entry during the run

  const result = await runVerifyJob({ enabled: true, staleWarnDays: 1 })

  expect(result.flagged).toBe(1)
  expect(getFlaggedThoughtIds(db)).toContain(id)
  const entry = getVerifyEntryByThoughtId(db, id)
  expect(entry?.flagged).toBe(1)
  expect(entry?.last_distance).toBeNull()
})
