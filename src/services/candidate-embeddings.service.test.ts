import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, drainPendingEmbeddings, withVecDb } from '../test/helpers'
import { closeDb } from '../db/init'
import { getDb } from '../db/container'
import { resolveCandidateEmbeddings } from './candidate-embeddings.service'

beforeEach(createTestDb)
afterEach(closeDb)

/** `vec_thoughts` is `FLOAT[384]`; `marker` in slot 0 identifies the vector. */
function vec(marker: number): Float32Array {
  const v = new Float32Array(384)
  v[0] = marker
  return v
}

/**
 * Store one vector for `id` (file-backed DB / vec0 only) and drain its queued
 * re-embed: these fixtures are all seeded by id only, so this names the state
 * "the vector is current". A candidate whose row is still pending is embedded
 * live on purpose (task #1569, R1).
 */
function storeVec(id: string, vector: Float32Array): void {
  getDb()
    .prepare(`INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)`)
    .run(id, Buffer.from(vector.buffer as ArrayBuffer, vector.byteOffset, vector.byteLength))
  drainPendingEmbeddings([id])
}

/** First component of every returned vector — the identity marker. */
function markers(vectors: Float32Array[]): number[] {
  return vectors.map(v => v[0])
}

test('embeds every candidate in order when the DB has no vec_thoughts (:memory:)', async () => {
  createTestDb()
  const candidates = [
    { id: 'a', content: 'alpha' },
    { id: 'b', content: 'beta' },
    { id: 'c', content: 'gamma' }
  ]
  const seen: string[][] = []

  const result = await resolveCandidateEmbeddings(candidates, async texts => {
    seen.push(texts)
    return texts.map((_, i) => vec(i + 1))
  }, getDb())

  expect(seen).toEqual([['alpha', 'beta', 'gamma']])
  expect(markers(result)).toEqual([1, 2, 3])
})

test('makes 0 embedder calls when every candidate has a stored vector', async () => {
  await withVecDb(async db => {
    const candidates = [
      { id: 'a', content: 'alpha' },
      { id: 'b', content: 'beta' }
    ]
    storeVec('a', vec(11))
    storeVec('b', vec(22))
    let embedCalls = 0

    const result = await resolveCandidateEmbeddings(candidates, async texts => {
      embedCalls++
      return texts.map(() => vec(999))
    }, db)

    expect(embedCalls).toBe(0)
    expect(markers(result)).toEqual([11, 22])
  })
})

test('embeds exactly the missing candidates, in candidate order, and covers all of them', async () => {
  await withVecDb(async db => {
    const candidates = [
      { id: 'a', content: 'alpha' },
      { id: 'b', content: 'beta' },
      { id: 'c', content: 'gamma' },
      { id: 'd', content: 'delta' }
    ]
    // b and d are stored; a and c must be embedded — the call keeps candidate
    // order, not map order, and the merged result stays aligned to candidates.
    storeVec('b', vec(22))
    storeVec('d', vec(44))
    const seen: string[][] = []

    const result = await resolveCandidateEmbeddings(candidates, async texts => {
      seen.push(texts)
      return texts.map(t => vec(t === 'alpha' ? 1 : 3))
    }, db)

    expect(seen).toEqual([['alpha', 'gamma']])
    expect(result).toHaveLength(4)
    expect(markers(result)).toEqual([1, 22, 3, 44])
    // Coverage: every candidate resolved to a vector, none dropped.
    expect(result.every(v => v instanceof Float32Array && v.length === 384)).toBe(true)
  })
})

test('returns an empty list and calls nothing for zero candidates', async () => {
  await withVecDb(async db => {
    let embedCalls = 0
    const result = await resolveCandidateEmbeddings([], async texts => {
      embedCalls++
      return texts.map(() => vec(1))
    }, db)

    expect(result).toEqual([])
    expect(embedCalls).toBe(0)
  })
})

test('throws when the embedder returns the wrong number of vectors', async () => {
  await withVecDb(async db => {
    const candidates = [
      { id: 'a', content: 'alpha' },
      { id: 'b', content: 'beta' }
    ]
    // Nothing stored, so both candidates are missing and the embedder owes two
    // vectors; a short reply must surface instead of silently shifting rows.
    await expect(
      resolveCandidateEmbeddings(candidates, async () => [vec(1)], db)
    ).rejects.toThrow('embedder returned 1 vectors for 2 candidates')
  })
})

test('keeps candidates without a vec_thoughts row and stored ones side by side', async () => {
  await withVecDb(async db => {
    const candidates = [
      { id: 'absent', content: 'missing content' },
      { id: 'present', content: 'stored content' }
    ]
    storeVec('present', vec(7))
    const seen: string[][] = []

    const result = await resolveCandidateEmbeddings(candidates, async texts => {
      seen.push(texts)
      return texts.map(() => vec(5))
    }, db)

    // Only the absent candidate is embedded; the stored one keeps its vector.
    expect(seen).toEqual([['missing content']])
    expect(markers(result)).toEqual([5, 7])
  })
})
