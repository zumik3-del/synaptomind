import { afterEach, describe, expect, test } from 'bun:test'
import { createTestDb, seedThought, withVecDb } from '../test/helpers'
import { getDb } from './container'
import { closeDb } from './init'
import { getPendingEmbeddingIds, getThoughtEmbeddingsBatch } from './embeddings'

afterEach(closeDb)

/** `vec_thoughts` is `FLOAT[384]`, so every stored vector needs the model dimension. */
function vec384(values: number[] = []): Float32Array {
  const v = new Float32Array(384)
  values.forEach((value, i) => {
    v[i] = value
  })
  return v
}

/** Store one raw vector in vec_thoughts (file-backed DB / vec0 only). */
function insertVec(id: string, vector: Float32Array): void {
  getDb()
    .prepare(`INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)`)
    .run(id, Buffer.from(vector.buffer as ArrayBuffer, vector.byteOffset, vector.byteLength))
}

describe('getThoughtEmbeddingsBatch', () => {
  test('returns exactly the ids present in vec_thoughts, omitting absent ones', async () => {
    await withVecDb(db => {
      insertVec('a', vec384([1, 2, 3]))
      insertVec('c', vec384([4, 5, 6]))

      const map = getThoughtEmbeddingsBatch(db, ['a', 'b', 'c'])

      expect([...map.keys()].sort()).toEqual(['a', 'c'])
      expect(map.has('b')).toBe(false)
      expect(map.get('a')!.length).toBe(384)
      expect(Array.from(map.get('a')!.slice(0, 3))).toEqual([1, 2, 3])
      expect(Array.from(map.get('c')!.slice(0, 3))).toEqual([4, 5, 6])
    })
  })

  test('returns owned copies: deleting the row afterwards leaves the returned data intact', async () => {
    await withVecDb(db => {
      insertVec('a', vec384([1, 2, 3]))

      const map = getThoughtEmbeddingsBatch(db, ['a'])
      const returned = map.get('a')!
      returned[0] = 99
      db.prepare(`DELETE FROM vec_thoughts WHERE id = ?`).run('a')

      expect(getThoughtEmbeddingsBatch(db, ['a']).size).toBe(0)
      expect(Array.from(returned.slice(0, 3))).toEqual([99, 2, 3])
      expect(Array.from(map.get('a')!.slice(0, 3))).toEqual([99, 2, 3])
    })
  })

  test('does not alias a caller-supplied buffer into the returned vectors', async () => {
    await withVecDb(db => {
      const source = vec384([7, 8])
      insertVec('a', source)
      const returned = getThoughtEmbeddingsBatch(db, ['a']).get('a')!
      expect(returned.buffer).not.toBe(source.buffer)

      source[0] = 500
      expect(returned[0]).toBe(7)
      returned[1] = 42
      expect(source[1]).toBe(8)
    })
  })

  test('returns an empty map for an empty id list', async () => {
    await withVecDb(db => {
      insertVec('a', vec384([1, 2]))
      expect(getThoughtEmbeddingsBatch(db, []).size).toBe(0)
    })
  })

  test('returned vectors survive a write-over of the source row (owned copies)', async () => {
    await withVecDb(db => {
      insertVec('a', vec384([1, 2, 3]))
      const before = getThoughtEmbeddingsBatch(db, ['a']).get('a')!

      // Overwrite the source row the way production does — DELETE + INSERT
      // (embedder/queue.ts) — and re-read: the DB now serves the new vector
      // while the previously returned vector must still hold the old one.
      db.prepare(`DELETE FROM vec_thoughts WHERE id = ?`).run('a')
      insertVec('a', vec384([9, 8, 7]))

      const after = getThoughtEmbeddingsBatch(db, ['a']).get('a')!
      expect(Array.from(after.slice(0, 3))).toEqual([9, 8, 7])
      expect(Array.from(before.slice(0, 3))).toEqual([1, 2, 3])
      expect(before.buffer).not.toBe(after.buffer)
    })
  })

  test('returns an empty map without throwing when vec_thoughts does not exist (:memory:)', () => {
    createTestDb()
    const db = getDb()
    const exists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = 'vec_thoughts'`)
      .get()
    expect(exists ?? undefined).toBeUndefined()

    expect(() => getThoughtEmbeddingsBatch(db, ['a', 'b'])).not.toThrow()
    expect(getThoughtEmbeddingsBatch(db, ['a', 'b']).size).toBe(0)
    expect(getThoughtEmbeddingsBatch(db, []).size).toBe(0)
  })
})

/**
 * Task #1573 (AC7 of the parent #1572) — the freshness signal and its degraded
 * shape. `pending_embeddings` is the ONLY signal `resolveCandidateEmbeddings`
 * has for "this stored vector no longer matches the content" (R1, #1569), so the
 * read must never come back empty on a fault: an empty set would let the
 * resolver score a candidate from its stale vector. It must not abort the run
 * either (task #1572 AC4), hence "all pending": every candidate is embedded
 * live.
 */
describe('getPendingEmbeddingIds (freshness signal + read-error fallback)', () => {
  test('reports exactly the queued ids per candidate set', () => {
    createTestDb()
    const db = getDb()
    const queued = seedThought({ content: 'queued' })
    const other = seedThought({ content: 'also queued' })
    // Seeding queues both (v035 trigger); drain one to model "already embedded".
    db.prepare('DELETE FROM pending_embeddings WHERE thought_id = ?').run(other)

    expect(getPendingEmbeddingIds(db, [queued, other])).toEqual(new Set([queued]))
    expect(getPendingEmbeddingIds(db, [other])).toEqual(new Set())
    expect(getPendingEmbeddingIds(db, [])).toEqual(new Set())
  })

  test('a failed pending read reports EVERY requested id as pending instead of throwing', () => {
    createTestDb()
    const db = getDb()
    const first = seedThought({ content: 'first' })
    const second = seedThought({ content: 'second' })
    // Precondition: the read works and sees the queued rows.
    expect(getPendingEmbeddingIds(db, [first, second])).toEqual(new Set([first, second]))

    // Break ONLY the freshness read, exactly as the resolver's own read fails.
    db.exec('ALTER TABLE pending_embeddings RENAME TO pending_embeddings_hidden')

    // NON-VACUITY: the fixture really does break the read — the pre-#1572 shape
    // of this read (unguarded SELECT, no try/catch) throws on it, which is the
    // contract the parent task replaced. Without this check the fallback
    // assertion below could pass because the rename never took effect.
    const preFixRead = (id: string): unknown[] =>
      db.prepare('SELECT thought_id FROM pending_embeddings WHERE thought_id = ?').all(id)
    expect(() => preFixRead(first)).toThrow(/pending_embeddings/)

    // Shipped contract: fail CLOSED (never "nothing pending") and AVAILABLE.
    expect(() => getPendingEmbeddingIds(db, [first, second])).not.toThrow()
    expect(getPendingEmbeddingIds(db, [first, second])).toEqual(new Set([first, second]))
    // Ids with no queue row at all are reported pending too — the safe direction
    // is a live re-embed, never a stored vector.
    expect(getPendingEmbeddingIds(db, ['no-such-thought'])).toEqual(new Set(['no-such-thought']))
    expect(getPendingEmbeddingIds(db, [])).toEqual(new Set())

    db.exec('ALTER TABLE pending_embeddings_hidden RENAME TO pending_embeddings')
  })
})
