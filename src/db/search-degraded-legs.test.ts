import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../context/container'
import { closeDb } from './init'
import { bm25ScoredIds } from './search-bm25'
import { vecSearchIds } from './search-vector'
import { searchThoughts } from './search'
import { createTestDb, seedThought } from '../test/helpers'

beforeEach(createTestDb)
afterEach(closeDb)

// `:memory:` cannot host vec0, so the vector leg fails exactly as it does on a host whose
// extension is missing; the fts table is dropped where the lexical leg has to fail.
const NO_SCOPE = { sql: '', params: [] }

function dropFts(): void {
  getDb().run(`DROP TABLE thoughts_fts`)
}

function embedding(): Float32Array {
  return new Float32Array([0.1, 0.2, 0.3])
}

test('a broken fts table degrades the lexical leg to no hits instead of failing the search', () => {
  const db = getDb()
  seedThought({ content: 'graph traversal notes', status: 'active' })
  dropFts()

  expect(bm25ScoredIds(db, 'graph', 10, false)).toEqual([])
})

test('the lexical leg rethrows when the caller asked for the error', () => {
  const db = getDb()
  dropFts()

  expect(() => bm25ScoredIds(db, 'graph', 10, true)).toThrow('no such table: thoughts_fts')
})

test('a missing vector table degrades the vector leg to no hits', () => {
  const ids = vecSearchIds(getDb(), embedding(), 10, NO_SCOPE, NO_SCOPE, 5, false)

  expect(ids).toEqual([])
})

test('the vector leg rethrows when the caller asked for the error', () => {
  expect(() => vecSearchIds(getDb(), embedding(), 10, NO_SCOPE, NO_SCOPE, 5, true)).toThrow(
    'no such table: vec_thoughts'
  )
})

test('a search whose both legs fail comes back empty and marked degraded', () => {
  const db = getDb()
  seedThought({ content: 'graph traversal notes', status: 'active' })
  dropFts()

  const results = searchThoughts(db, {
    embedding: embedding(),
    query: 'graph',
    topK: 5,
    statusFilter: 'active'
  })

  expect(results).toEqual([])
  expect((results as unknown as { degraded: boolean }).degraded).toBe(true)
})

test('a healthy lexical leg keeps the answer out of the degraded state', () => {
  const db = getDb()
  seedThought({ content: 'graph traversal notes', status: 'active' })

  const results = searchThoughts(db, {
    embedding: new Float32Array(0),
    query: 'graph',
    topK: 5,
    statusFilter: 'active'
  })

  expect(results.map(result => result.thought.content)).toEqual(['graph traversal notes'])
  expect((results as unknown as { degraded: boolean }).degraded).toBe(false)
})
