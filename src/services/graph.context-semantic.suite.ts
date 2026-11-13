import { describe, expect, mock, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import {
  drainPendingEmbeddings,
  isVecExtensionAvailable,
  seedThought,
  withVecDb
} from '../test/helpers'
import { getContextService } from './graph.service'
import { searchThoughts } from './search.service'

const VECTOR = new Float32Array(384)
for (let i = 0; i < VECTOR.length; i++) VECTOR[i] = 0.25

let queryVector: Float32Array = VECTOR

mock.module('../embedder/client', () => ({
  generateEmbedding: async () => queryVector,
  generateEmbeddings: async () => [queryVector],
  isEmbedderReady: () => true
}))

function itVec(name: string, fn: (db: Database) => void | Promise<void>): void {
  test.skipIf(!isVecExtensionAvailable())(name, () => withVecDb(fn))
}

function vectorAtCos(cos: number): Float32Array {
  const v = new Float32Array(384)
  v[0] = cos
  v[1] = Math.sqrt(Math.max(0, 1 - cos * cos))
  return v
}

function insertVector(db: Database, thoughtId: string, vector: Float32Array): void {
  const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
  db.prepare(`INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, 'default')`).run(
    thoughtId,
    buf
  )
}

describe('getContextService uses real embeddings', () => {
  itVec('returns a semantically matched thought even when BM25 does not match', async db => {
    const id = seedThought({ content: 'semantic context target thought' })
    drainPendingEmbeddings([id])
    const buf = Buffer.from(VECTOR.buffer, VECTOR.byteOffset, VECTOR.byteLength)
    db.prepare(`INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, 'default')`).run(
      id,
      buf
    )

    const ctx = await getContextService('zzzznomatchtoken', { maxDegree: 3 }, db)

    expect(ctx).not.toBeNull()
    expect(ctx!.best_match!.id).toBe(id)
    expect(ctx!.degraded).toBe(false)
  })
})

describe('getContextService keeps the pre-gate best match (task #2187)', () => {
  const QUERY = 'zzzzweakgatenolexicalmatch'

  async function seedWeakPair(db: Database): Promise<string> {
    const id = seedThought({ content: 'WEAK_GATE context target' })
    drainPendingEmbeddings([id])
    insertVector(db, id, vectorAtCos(1))
    return id
  }

  itVec('returns the weak cosine-only best match that the default search gate drops', async db => {
    const id = await seedWeakPair(db)
    queryVector = vectorAtCos(0.83)
    try {
      const gated = await searchThoughts({ query: QUERY, topK: 5, statusFilter: 'active' }, db)
      expect(gated).toEqual([])

      const ctx = await getContextService(QUERY, { maxDegree: 3 })

      expect(ctx).not.toBeNull()
      expect(ctx!.best_match!.id).toBe(id)
      expect(ctx!.degraded).toBe(false)
    } finally {
      queryVector = VECTOR
    }
  })

  itVec('an explicit min_relevance on a search call does not leak into context', async db => {
    const id = await seedWeakPair(db)
    queryVector = vectorAtCos(0.83)
    try {
      const gated = await searchThoughts(
        { query: QUERY, topK: 5, statusFilter: 'active', minRelevance: 1 },
        db
      )
      expect(gated).toEqual([])

      const ctx = await getContextService(QUERY, { maxDegree: 3 })

      expect(ctx).not.toBeNull()
      expect(ctx!.best_match!.id).toBe(id)
    } finally {
      queryVector = VECTOR
    }
  })
})
