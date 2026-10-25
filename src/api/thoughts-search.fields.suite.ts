import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { closeDb } from '../db/init'
import { createTestDb, isVecExtensionAvailable, seedThought, withVecDb } from '../test/helpers'
import { createApp } from './router'

/**
 * Task #2178 — HTTP regression guard for `GET /api/thoughts/search`.
 *
 * The search change is additive: it may add `relevance` and the `id` match
 * source, but it must not remove or rename a documented field
 * (docs/API.md §GET /api/thoughts/search: `thought`, `distance`, `similarity`,
 * `standing`) and it must not reshape the array response. This file pins that
 * wire contract plus the two behaviours the route itself owns: the id lookup
 * bypassing the documented `status=active` default, and the `min_relevance`
 * query parameter reaching the service.
 *
 * The embedder is mocked (a fixed `e0` vector) exactly like the neighbouring
 * `thoughts-search.*.test.ts` files, so the suite stays offline and the vector
 * similarity is controlled by the seeded `vec_thoughts` rows.
 */

const DIM = 384

/** The mocked query embedding: `e0`. */
const QUERY_VEC = (() => {
  const v = new Float32Array(DIM)
  v[0] = 1
  return v
})()

mock.module('../embedder/client', () => ({
  generateEmbedding: async () => QUERY_VEC,
  generateEmbeddings: async () => [QUERY_VEC],
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

process.env.SYNAPTOMIND_SECRET = 'test-token'
const app = createApp()

const VEC_AVAILABLE = isVecExtensionAvailable()

async function request(path: string): Promise<Response> {
  const headers = new Headers()
  headers.set('Authorization', 'Bearer test-token')
  return app.request(path, { headers })
}

interface Body {
  thought: { id: string; content: string; status: string; created_at: string }
  match_source: string[]
  low_confidence: boolean
  similarity?: number
  distance?: number
  relevance?: number
  standing?: string
}

async function searchBody(query: string): Promise<Body[]> {
  const res = await request(`/api/thoughts/search?${query}`)
  expect(res.status).toBe(200)
  return (await res.json()) as Body[]
}

/** Seed a `vec_thoughts` row whose cosine similarity to `e0` is `cos`. */
function seedVector(db: Database, thoughtId: string, cos: number): void {
  const vector = new Float32Array(DIM)
  vector[0] = cos
  vector[1] = Math.sqrt(Math.max(0, 1 - cos * cos))
  db.prepare(`INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)`).run(
    thoughtId,
    Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
  )
}

beforeEach(createTestDb)
afterEach(closeDb)

describe('GET /api/thoughts/search — documented response fields survive', () => {
  test('a lexical hit keeps the documented shape and gains no invented signal', async () => {
    const id = seedThought({ content: 'FIELDS_MARKER documented contract' })
    const db = (await import('../db/container')).getDb()
    db.prepare(`INSERT INTO thoughts_fts (thought_id, content) VALUES (?, ?)`).run(
      id,
      'FIELDS_MARKER documented contract'
    )

    const body = await searchBody('q=FIELDS_MARKER')

    expect(body).toHaveLength(1)
    const [hit] = body
    // Documented: `thought` (id, content, ...) and `standing`.
    expect(hit.thought.id).toBe(id)
    expect(hit.thought.content).toBe('FIELDS_MARKER documented contract')
    expect(hit.thought.status).toBe('active')
    expect(typeof hit.thought.created_at).toBe('string')
    expect(hit.standing).toBe('current')
    // Pre-existing signal fields stay on the wire.
    expect(hit.match_source).toEqual(['bm25'])
    expect(hit.low_confidence).toBe(false)
    // A BM25-only hit has no cosine signal — `distance`/`similarity` are not
    // fabricated, and `relevance` follows the same rule (task #2178).
    expect(hit.similarity).toBeUndefined()
    expect(hit.distance).toBeUndefined()
    expect(hit.relevance).toBeUndefined()
  })

  test('an id query bypasses the documented status=active default', async () => {
    const id = seedThought({ content: 'HTTP_ID draft content', status: 'draft' })

    const body = await searchBody(`q=${id}`)

    expect(body.map(r => r.thought.id)).toEqual([id])
    expect(body[0].thought.status).toBe('draft')
    expect(body[0].match_source).toEqual(['id'])
  })
})

describe('GET /api/thoughts/search — vector leg still reports distance/similarity', () => {
  test.skipIf(!VEC_AVAILABLE)('a vector hit keeps distance/similarity and adds relevance', async () => {
    await withVecDb(async db => {
      const id = seedThought({ content: 'VEC_HTTP note about deploys' })
      seedVector(db, id, 1)

      const body = await searchBody('q=semantically%20related%20request&hybrid=1')

      expect(body.map(r => r.thought.id)).toEqual([id])
      expect(body[0].match_source).toEqual(['embedding'])
      expect(body[0].similarity).toBeCloseTo(1, 6)
      expect(body[0].distance).toBeCloseTo(0, 6)
      // Additive field from #2178: the calibrated relevance.
      expect(body[0].relevance).toBeCloseTo(1, 6)
      expect(body[0].standing).toBe('current')
    })
  })

  test.skipIf(!VEC_AVAILABLE)('min_relevance=0 restores the fail-open set over HTTP', async () => {
    await withVecDb(async db => {
      const strong = seedThought({ content: 'HTTP_GATE strong note' })
      const weak = seedThought({ content: 'HTTP_GATE weak note' })
      seedVector(db, strong, 1)
      seedVector(db, weak, 0.3)

      // Default gate (0.4 calibrated): the weak row is dropped.
      const gated = await searchBody('q=nothing%20lexically%20matching&hybrid=1')
      expect(gated.map(r => r.thought.id)).toEqual([strong])

      // Explicit 0 turns the gate off: both rows are back.
      const failOpen = await searchBody('q=nothing%20lexically%20matching&hybrid=1&min_relevance=0')
      expect(failOpen.map(r => r.thought.id)).toEqual([strong, weak])
    })
  })
})
