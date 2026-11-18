import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../context/container'
import { closeDb } from './init'
import { createTestDb, seedThought } from '../test/helpers'
import { fetchThoughtsByIds, isStrongMatch } from './search-hydrate'
import type { SearchOptions } from './search-types'

beforeEach(createTestDb)
afterEach(closeDb)

const NO_RECENCY = {
  rrfMax: 0,
  recencyActive: false,
  recencyWeight: 0,
  recencyHalfLifeDays: 30,
  nowMs: Date.parse('2026-01-31T00:00:00.000Z')
}

const NO_HYDRATION = {
  vecSimById: new Map<string, number>(),
  bm25ScoreById: new Map<string, number>(),
  rrfScoreById: new Map<string, number>(),
  confidenceFloor: 0.5
}

function options(overrides: Partial<SearchOptions> = {}): SearchOptions {
  return { embedding: new Float32Array(0), ...overrides }
}

test('hydration returns the rows in the caller order and skips ids that do not exist', () => {
  const first = seedThought({
    content: 'first',
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z'
  })
  const second = seedThought({
    content: 'second',
    status: 'active',
    created_at: '2026-01-02T00:00:00.000Z'
  })

  const results = fetchThoughtsByIds(
    getDb(),
    [second, 'missing-id', first],
    options(),
    NO_HYDRATION,
    NO_RECENCY
  )

  expect(results.map(result => result.thought.id)).toEqual([second, first])
  expect(results.map(result => result.thought.content)).toEqual(['second', 'first'])
})

test('hydration attaches the tags of each thought', () => {
  const tagged = seedThought({ tags: '["alpha", "beta"]' })

  const [result] = fetchThoughtsByIds(getDb(), [tagged], options(), NO_HYDRATION, NO_RECENCY)

  expect(result.thought.tags.map(tag => tag.name).sort()).toEqual(['alpha', 'beta'])
})

test('an empty id list short-circuits without a query', () => {
  expect(fetchThoughtsByIds(getDb(), [], options(), NO_HYDRATION, NO_RECENCY)).toEqual([])
})

test('both legs report their own score and the match source names them', () => {
  const id = seedThought({ content: 'fused' })
  const hydration = {
    vecSimById: new Map([[id, 0.8]]),
    bm25ScoreById: new Map([[id, 2.5]]),
    rrfScoreById: new Map([[id, 0.03]]),
    confidenceFloor: 0.5
  }

  const [result] = fetchThoughtsByIds(getDb(), [id], options(), hydration, NO_RECENCY)

  expect(result.match_source).toEqual(['embedding', 'bm25'])
  expect(result.similarity).toBeCloseTo(0.8, 10)
  expect(result.distance).toBeCloseTo(0.2, 10)
  expect(result.bm25_score).toBe(2.5)
  expect(result.rrf_score).toBe(0.03)
  expect(result.low_confidence).toBe(false)
})

test('an embedding below the confidence floor is flagged, and no similarity leaves it unset', () => {
  const weak = seedThought({ content: 'weak vector match' })
  const lexical = seedThought({ content: 'lexical match' })

  const results = fetchThoughtsByIds(
    getDb(),
    [weak, lexical],
    options(),
    {
      vecSimById: new Map([[weak, 0.2]]),
      bm25ScoreById: new Map([[lexical, 1]]),
      rrfScoreById: new Map(),
      confidenceFloor: 0.5
    },
    NO_RECENCY
  )

  expect(results[0].low_confidence).toBe(true)
  expect(results[1].match_source).toEqual(['bm25'])
  expect(results[1].low_confidence).toBe(false)
  expect(Object.hasOwn(results[1], 'similarity')).toBe(false)
})

test('the hydrated set obeys the status and project filters it was given', () => {
  const active = seedThought({ content: 'active one', status: 'active' })
  const draft = seedThought({ content: 'draft one', status: 'draft' })
  const otherProject = seedThought({
    content: 'other project',
    status: 'active',
    project_id: 'project-b'
  })

  const results = fetchThoughtsByIds(
    getDb(),
    [active, draft, otherProject],
    options({ statusFilter: 'active', projectFilter: 'default' }),
    NO_HYDRATION,
    NO_RECENCY
  )

  expect(results).toHaveLength(1)
  expect(results[0].thought.id).toBe(active)
})

test('recency scoring is off unless asked for, and adds no score fields', () => {
  const id = seedThought({ content: 'no recency', created_at: '2026-01-01T00:00:00.000Z' })

  const [result] = fetchThoughtsByIds(getDb(), [id], options(), NO_HYDRATION, NO_RECENCY)

  expect(Object.hasOwn(result, 'recency_score')).toBe(false)
  expect(Object.hasOwn(result, 'final_score')).toBe(false)
})

test('recency scoring decays a month-old thought to half and reorders by the final score', () => {
  const old = seedThought({ content: 'old', created_at: '2026-01-01T00:00:00.000Z' })
  const fresh = seedThought({ content: 'fresh', created_at: '2026-01-31T00:00:00.000Z' })
  const hydration = {
    vecSimById: new Map([
      [old, 1],
      [fresh, 1]
    ]),
    bm25ScoreById: new Map(),
    rrfScoreById: new Map(),
    confidenceFloor: 0.5
  }

  const results = fetchThoughtsByIds(getDb(), [old, fresh], options(), hydration, {
    ...NO_RECENCY,
    recencyActive: true,
    recencyWeight: 0.5
  })

  expect(results.map(result => result.thought.id)).toEqual([fresh, old])
  expect(results[0].recency_score).toBeCloseTo(1, 10)
  expect(results[1].recency_score).toBeCloseTo(0.5, 10)
  expect(results[1].final_score).toBeCloseTo(1 + 0.5 * 0.5, 10)
})

test('an unparseable created_at scores full recency instead of dropping the row', () => {
  const id = seedThought({ content: 'undated', created_at: 'not-a-timestamp' })

  const [result] = fetchThoughtsByIds(getDb(), [id], options(), NO_HYDRATION, {
    ...NO_RECENCY,
    recencyActive: true,
    recencyWeight: 1
  })

  expect(result.recency_score).toBe(1)
})

test('a strong match is a bm25 or id hit, or an embedding above the floor', () => {
  const floor = 0.6

  expect(isStrongMatch({ match_source: ['id'] }, floor)).toBe(true)
  expect(isStrongMatch({ match_source: ['bm25'], similarity: 0 }, floor)).toBe(true)
  expect(isStrongMatch({ match_source: ['embedding'], similarity: 0.6 }, floor)).toBe(true)
  expect(isStrongMatch({ match_source: ['embedding'], similarity: 0.59 }, floor)).toBe(false)
  expect(isStrongMatch({ match_source: [], similarity: 1 }, floor)).toBe(false)
  expect(isStrongMatch({ match_source: ['embedding'] }, floor)).toBe(false)
})
