import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, drainPendingEmbeddings, withVecDb } from '../test/helpers'
import { closeDb } from '../db/init'
import { getDb } from '../context/container'
import { resolveCandidateEmbeddings } from './candidate-embeddings.service'

beforeEach(createTestDb)
afterEach(closeDb)

/** `vec_thoughts` is `FLOAT[384]`; `marker` in slot 0 identifies the vector. */
function vec(marker: number): Float32Array {
  const v = new Float32Array(384)
  v[0] = marker
  return v
}

function storeVec(id: string, vector: Float32Array): void {
  getDb()
    .prepare(`INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, 'default')`)
    .run(id, Buffer.from(vector.buffer as ArrayBuffer, vector.byteOffset, vector.byteLength))
  drainPendingEmbeddings([id])
}

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

  const result = await resolveCandidateEmbeddings(
    candidates,
    async texts => {
      seen.push(texts)
      return texts.map((_, i) => vec(i + 1))
    },
    getDb()
  )

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

    const result = await resolveCandidateEmbeddings(
      candidates,
      async texts => {
        embedCalls++
        return texts.map(() => vec(999))
      },
      db
    )

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
    storeVec('b', vec(22))
    storeVec('d', vec(44))
    const seen: string[][] = []

    const result = await resolveCandidateEmbeddings(
      candidates,
      async texts => {
        seen.push(texts)
        return texts.map(t => vec(t === 'alpha' ? 1 : 3))
      },
      db
    )

    expect(seen).toEqual([['alpha', 'gamma']])
    expect(result).toHaveLength(4)
    expect(markers(result)).toEqual([1, 22, 3, 44])
    expect(result.every(v => v instanceof Float32Array && v.length === 384)).toBe(true)
  })
})

test('returns an empty list and calls nothing for zero candidates', async () => {
  await withVecDb(async db => {
    let embedCalls = 0
    const result = await resolveCandidateEmbeddings(
      [],
      async texts => {
        embedCalls++
        return texts.map(() => vec(1))
      },
      db
    )

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
    await expect(resolveCandidateEmbeddings(candidates, async () => [vec(1)], db)).rejects.toThrow(
      'embedder returned 1 vectors for 2 candidates'
    )
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

    const result = await resolveCandidateEmbeddings(
      candidates,
      async texts => {
        seen.push(texts)
        return texts.map(() => vec(5))
      },
      db
    )

    expect(seen).toEqual([['missing content']])
    expect(markers(result)).toEqual([5, 7])
  })
})
