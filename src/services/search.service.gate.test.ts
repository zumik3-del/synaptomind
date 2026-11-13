import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { createEdge } from '../db/edges'
import { closeDb } from '../db/init'
import { createTestDb, isVecExtensionAvailable, seedThought, withVecDb } from '../test/helpers'
import { DEFAULT_MIN_RELEVANCE } from './search-normalize.service'
import { searchThoughts, searchThoughtsOutcome } from './search.service'

const DIM = 384
const VEC_AVAILABLE = isVecExtensionAvailable()

beforeEach(createTestDb)
afterEach(closeDb)

function vectorAtCos(cos: number): Float32Array {
  const v = new Float32Array(DIM)
  v[0] = cos
  v[1] = Math.sqrt(Math.max(0, 1 - cos * cos))
  return v
}

const QUERY = vectorAtCos(1)

function seedVector(db: Database, thoughtId: string, cos: number): void {
  const vector = vectorAtCos(cos)
  db.prepare(`INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, 'default')`).run(
    thoughtId,
    Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
  )
}

function itVec(name: string, fn: (db: Database) => void | Promise<void>): void {
  test.skipIf(!VEC_AVAILABLE)(name, () => withVecDb(fn))
}

function vectorOptions(extra: Record<string, unknown> = {}) {
  return {
    query: 'a query with no lexical overlap',
    embedding: QUERY,
    hybrid: false,
    topK: 10,
    ...extra
  }
}

describe('default relevance gate', () => {
  itVec(
    'a nonsense query returns zero rows and reports every candidate as filtered_out',
    async db => {
      const ids = [
        seedThought({ content: 'WEEKDAY_CORPUS alpha note' }),
        seedThought({ content: 'WEEKDAY_CORPUS beta note' }),
        seedThought({ content: 'WEEKDAY_CORPUS gamma note' })
      ]
      seedVector(db, ids[0], 0.3)
      seedVector(db, ids[1], 0.2)
      seedVector(db, ids[2], 0.1)

      const outcome = await searchThoughtsOutcome(
        vectorOptions({ query: 'how do I grill a steak' }),
        db
      )

      expect(outcome.items).toEqual([])
      expect(outcome.matched).toBe(3)
      expect(outcome.filtered_out).toBe(3)
      expect(outcome.reason).toBeUndefined()
    }
  )

  itVec('five realistic queries land on their expected top-1 without losing recall', async db => {
    const target = [
      seedThought({ content: 'changing where the SQLite file lives on disk' }),
      seedThought({ content: 'throttling inbound HTTP requests per minute' }),
      seedThought({ content: 'unloading the embedding worker when idle' }),
      seedThought({ content: 'restoring a database backup after a failed update' }),
      seedThought({ content: 'keeping an MCP session alive between calls' })
    ]
    for (let i = 0; i < target.length; i++) {
      const vector = new Float32Array(DIM)
      vector[i] = 1
      db.prepare(`INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, 'default')`).run(
        target[i],
        Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
      )
    }

    const probes: Array<{ query: string; axis: number }> = [
      { query: 'how do I point the server at a different database file', axis: 0 },
      { query: 'limit the number of requests a client can make', axis: 1 },
      { query: 'stop the model process when nobody searches', axis: 2 },
      { query: 'bring back last night’s data after a bad deploy', axis: 3 },
      { query: 'does the transport drop long-lived connections', axis: 4 }
    ]

    for (const probe of probes) {
      const embedding = new Float32Array(DIM)
      embedding[probe.axis] = 1

      const outcome = await searchThoughtsOutcome(
        { query: probe.query, embedding, hybrid: false, topK: 10 },
        db
      )

      expect(outcome.items[0]?.thought.id).toBe(target[probe.axis])
      expect(outcome.items).toHaveLength(1)
      expect(outcome.items[0].relevance).toBeCloseTo(1, 6)
      expect(outcome.matched).toBe(5)
      expect(outcome.filtered_out).toBe(4)
    }
  })

  itVec('min_relevance: 0 restores the fail-open set, same rows and same order', async db => {
    const strong = seedThought({ content: 'FAILOPEN strong note' })
    const mid = seedThought({ content: 'FAILOPEN mid note' })
    const weak = seedThought({ content: 'FAILOPEN weak note' })
    seedVector(db, strong, 0.95)
    seedVector(db, mid, 0.85)
    seedVector(db, weak, 0.82)

    const ungated = await searchThoughtsOutcome(vectorOptions({ minRelevance: 0 }), db)
    const gated = await searchThoughtsOutcome(vectorOptions(), db)
    const ungatedArray = await searchThoughts(vectorOptions({ minRelevance: 0 }), db)

    expect(ungated.items.map(r => r.thought.id)).toEqual([strong, mid, weak])
    expect(ungated.filtered_out).toBe(0)
    expect(ungatedArray.map(r => r.thought.id)).toEqual([strong, mid, weak])
    expect(ungated.items[0].relevance).toBeCloseTo(1, 6)
    expect(ungated.items[1].relevance).toBeCloseTo(0.5, 6)
    expect(ungated.items[2].relevance).toBeCloseTo(0.2, 6)

    expect(gated.items.map(r => r.thought.id)).toEqual([strong, mid])
    expect(gated.matched).toBe(3)
    expect(gated.filtered_out).toBe(1)
  })

  itVec('the default threshold is 0.4 on the calibrated scale', async db => {
    expect(DEFAULT_MIN_RELEVANCE).toBe(0.4)

    const below = seedThought({ content: 'THRESHOLD below note' })
    const above = seedThought({ content: 'THRESHOLD above note' })
    seedVector(db, below, 0.83)
    seedVector(db, above, 0.85)

    const outcome = await searchThoughtsOutcome(vectorOptions(), db)

    expect(outcome.items.map(r => r.thought.id)).toEqual([above])
    expect(outcome.filtered_out).toBe(1)
  })

  itVec('the calibration boundaries are 0.8 (unrelated) and 0.9 (strong)', async db => {
    const atFloor = seedThought({ content: 'BOUNDARY at floor note' })
    const atCeil = seedThought({ content: 'BOUNDARY at ceiling note' })
    seedVector(db, atFloor, 0.8)
    seedVector(db, atCeil, 0.9)

    const ungated = await searchThoughtsOutcome(vectorOptions({ minRelevance: 0 }), db)
    const byId = new Map(ungated.items.map(r => [r.thought.id, r]))
    expect(byId.get(atFloor)?.relevance).toBeCloseTo(0, 6)
    expect(byId.get(atCeil)?.relevance).toBeCloseTo(1, 6)

    const gated = await searchThoughtsOutcome(vectorOptions(), db)
    expect(gated.items.map(r => r.thought.id)).toEqual([atCeil])
  })

  itVec(
    'low_confidence stays meaningful: kept rows below the strong floor are flagged',
    async db => {
      const weakKept = seedThought({ content: 'LOWCONF weak-but-kept note' })
      const strongKept = seedThought({ content: 'LOWCONF strong-kept note' })
      seedVector(db, weakKept, 0.85)
      seedVector(db, strongKept, 0.95)

      const outcome = await searchThoughtsOutcome(vectorOptions(), db)
      const byId = new Map(outcome.items.map(r => [r.thought.id, r]))

      expect(byId.get(weakKept)?.low_confidence).toBe(true)
      expect(byId.get(strongKept)?.low_confidence).toBe(false)
    }
  )

  itVec(
    'a contested id hit keeps low_confidence false while a weak cosine-only hit keeps it true (task #2192)',
    async db => {
      const contested = seedThought({ content: 'LOWCONF contested claim' })
      const superseder = seedThought({ content: 'LOWCONF superseding claim' })
      createEdge(db, superseder, contested, 'replaces')
      const weak = seedThought({ content: 'LOWCONF weak-but-kept note' })
      seedVector(db, weak, 0.85)

      const byId = await searchThoughtsOutcome(
        { query: contested, topK: 10, supersessionMode: 'suppress' },
        db
      )
      expect(byId.items.map(r => r.thought.id)).toEqual([contested])
      expect(byId.items[0].standing).toBe('superseded')
      expect(byId.items[0].superseded_by).toEqual([superseder])
      expect(byId.items[0].low_confidence).toBe(false)

      const searched = await searchThoughtsOutcome(vectorOptions(), db)
      const weakHit = searched.items.find(r => r.thought.id === weak)
      expect(weakHit?.low_confidence).toBe(true)
    }
  )

  itVec('a BM25-only hit survives the gate and keeps relevance undefined', async db => {
    const bm25Only = seedThought({ content: 'VACUUM_TUNING maintenance notes' })
    db.prepare(`INSERT INTO thoughts_fts (thought_id, content) VALUES (?, ?)`).run(
      bm25Only,
      'VACUUM_TUNING maintenance notes'
    )
    const noise = seedThought({ content: 'unrelated semantic neighbour' })
    seedVector(db, noise, 0.3)

    const outcome = await searchThoughtsOutcome(
      { query: 'VACUUM_TUNING', embedding: QUERY, hybrid: true, topK: 10 },
      db
    )
    const ids = outcome.items.map(r => r.thought.id)

    expect(ids).toContain(bm25Only)
    expect(ids).not.toContain(noise)
    const hit = outcome.items.find(r => r.thought.id === bm25Only)!
    expect(hit.match_source).toEqual(['bm25'])
    expect(hit.relevance).toBeUndefined()
    expect(hit.low_confidence).toBe(false)
  })
})

describe('search.confidence.unrelatedFloor drives the calibration', () => {
  test('changing the resolved config key shifts the calibrated relevance', async () => {
    if (!VEC_AVAILABLE) return
    await withVecDb(async db => {
      const id = seedThought({ content: 'CONFIGKEY note' })
      seedVector(db, id, 0.7)

      const withDefault = await searchThoughtsOutcome(vectorOptions({ minRelevance: 0 }), db)
      expect(withDefault.items[0].relevance).toBeCloseTo(0, 6)

      const original = config.search.confidence.unrelatedFloor
      try {
        config.search.confidence.unrelatedFloor = 0.5
        const withOverride = await searchThoughtsOutcome(vectorOptions({ minRelevance: 0 }), db)
        expect(withOverride.items[0].relevance).toBeCloseTo(0.5, 6)

        const gated = await searchThoughtsOutcome(vectorOptions(), db)
        expect(gated.items.map(r => r.thought.id)).toEqual([id])
      } finally {
        config.search.confidence.unrelatedFloor = original
      }
    })
  })
})
