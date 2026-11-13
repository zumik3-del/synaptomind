import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { closeDb } from '../db/init'
import { createTestDb, isVecExtensionAvailable, seedThought, withVecDb } from '../test/helpers'
import { DEFAULT_MIN_RELEVANCE } from './search-normalize.service'
import { searchThoughtsOutcome } from './search.service'

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

function seedVector(db: Database, thoughtId: string, cos: number, scope: string): void {
  const vector = vectorAtCos(cos)
  db.prepare(`INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, ?)`).run(
    thoughtId,
    Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
    scope
  )
}

function itVec(name: string, fn: (db: Database) => void | Promise<void>): void {
  test.skipIf(!VEC_AVAILABLE)(name, () => withVecDb(fn))
}

describe('the scoped starvation flag is a vector-leg property', () => {
  const PROJECT = 'proj-addressed'
  const FOREIGN = 'proj-foreign'
  const TOKEN = 'STARVED_LEG_TOKEN'

  itVec('a BM25-delivered project row does not clear the flag', async db => {
    const own = seedThought({ content: `${TOKEN} addressed project note`, project_id: PROJECT })
    seedVector(db, own, 0, PROJECT)
    for (let i = 0; i < 8; i++) {
      const global = seedThought({
        content: `unrelated global filler ${i}`,
        project_id: FOREIGN,
        is_global: 1
      })
      seedVector(db, global, 1, '__global__')
    }

    const outcome = await searchThoughtsOutcome(
      { query: TOKEN, embedding: QUERY, projectFilter: PROJECT, topK: 2 },
      db
    )

    const hit = outcome.items.find(r => r.thought.id === own)
    expect(hit).toBeDefined()
    expect(hit?.match_source).toEqual(['bm25'])
    expect((outcome.items as { degraded?: boolean }).degraded).toBe(true)
    expect(hit?.degraded).toBe(true)
  })

  itVec('a project row the gate drops is filtered_out, not degraded', async db => {
    const own = seedThought({
      content: 'PROJECT_GATE_NOTE addressed project note',
      project_id: PROJECT
    })
    seedVector(db, own, 0.83, PROJECT)

    const ungated = await searchThoughtsOutcome(
      {
        query: 'a query with no lexical overlap',
        embedding: QUERY,
        hybrid: false,
        projectFilter: PROJECT,
        topK: 10,
        minRelevance: 0
      },
      db
    )
    expect(ungated.items.map(r => r.thought.id)).toEqual([own])
    expect(ungated.items[0].relevance).toBeLessThan(DEFAULT_MIN_RELEVANCE)
    expect(ungated.filtered_out).toBe(0)

    const gated = await searchThoughtsOutcome(
      {
        query: 'a query with no lexical overlap',
        embedding: QUERY,
        hybrid: false,
        projectFilter: PROJECT,
        topK: 10
      },
      db
    )

    expect(gated.items).toHaveLength(0)
    expect(gated.matched).toBe(1)
    expect(gated.filtered_out).toBe(1)
    expect((gated.items as { degraded?: boolean }).degraded).toBe(false)
  })
})
