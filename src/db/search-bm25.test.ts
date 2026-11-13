import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { getDb } from '../context/container'
import {
  createTestDb,
  drainPendingEmbeddings,
  isVecExtensionAvailable,
  seedThought,
  withVecDb
} from '../test/helpers'
import { closeDb } from './init'
import { bm25SearchIds, searchThoughts } from './search'
import { bm25ScoredIdsFiltered } from './search-bm25'
import { buildFilterSQL } from './search-filters'

const VEC_AVAILABLE = isVecExtensionAvailable()

beforeEach(createTestDb)
afterEach(closeDb)

const PROJECT = 'bm25-order-project'
const QUERY = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi'
const TARGET = 'bm25-order-target'
const WEAK_PREFIX = 'bm25-order-weak-'

function seedRankedProject(): string {
  for (let i = 0; i < 30; i++) {
    seedThought({
      id: weakId(i),
      project_id: PROJECT,
      content: `deployment note ${i} alpha ${'status '.repeat(i + 1)}`
    })
  }
  return seedThought({ id: TARGET, project_id: PROJECT, content: QUERY })
}

function weakId(i: number): string {
  return `${WEAK_PREFIX}${String(i).padStart(2, '0')}`
}

function expectedTopIds(count: number): string[] {
  return [TARGET, ...Array.from({ length: count - 1 }, (_, i) => weakId(i))]
}

function serviceFilter() {
  return buildFilterSQL({ statusFilter: 'active', projectFilter: PROJECT })
}

test('project-filtered BM25 leg returns ids in non-increasing relevance', () => {
  const db = getDb()
  const target = seedRankedProject()
  const filter = serviceFilter()

  const scored = bm25ScoredIdsFiltered(db, QUERY, 10, filter.sql, filter.params)

  expect(scored).toHaveLength(10)
  for (let i = 1; i < scored.length; i++) {
    expect(scored[i - 1].score).toBeGreaterThanOrEqual(scored[i].score)
  }
  expect(scored[0].id).toBe(target)
})

test('the cap keeps the best-scoring matches, not an arbitrary subset', () => {
  const db = getDb()
  seedRankedProject()
  const filter = serviceFilter()

  const best = bm25ScoredIdsFiltered(db, QUERY, 1000, '', []).slice(0, 10)
  expect(new Set(best.map(r => r.score)).size).toBe(best.length)

  const capped = bm25ScoredIdsFiltered(db, QUERY, 10, filter.sql, filter.params)

  expect(capped.map(r => r.id)).toEqual(best.map(r => r.id))
  expect(capped.map(r => r.id)).toEqual(expectedTopIds(10))
})

test('equal scores break on thought_id, so a tie straddling the cap is stable', () => {
  const db = getDb()
  const later = seedThought({ id: 'bm25-tie-z', project_id: PROJECT, content: 'tie probe' })
  const earlier = seedThought({ id: 'bm25-tie-a', project_id: PROJECT, content: 'tie probe' })
  const filter = serviceFilter()

  const [first, second] = bm25ScoredIdsFiltered(db, 'tie probe', 2, filter.sql, filter.params)
  expect(first.score).toBe(second.score)

  for (let run = 0; run < 5; run++) {
    const both = bm25ScoredIdsFiltered(db, 'tie probe', 2, filter.sql, filter.params)
    expect(both.map(r => r.id)).toEqual([earlier, later])
    const single = bm25ScoredIdsFiltered(db, 'tie probe', 1, filter.sql, filter.params)
    expect(single.map(r => r.id)).toEqual([earlier])
  }
})

test('project-scoped search without vectors ranks the query thought first', () => {
  const db = getDb()
  const target = seedRankedProject()
  seedThought({ id: 'bm25-order-foreign', project_id: 'another-project', content: QUERY })

  const results = searchThoughts(db, {
    embedding: new Float32Array(0),
    query: QUERY,
    topK: 10,
    hybrid: true,
    statusFilter: 'active',
    projectFilter: PROJECT
  })

  expect(results[0]?.thought.id).toBe(target)
  expect(results.every(r => r.thought.project_id === PROJECT)).toBe(true)
})

test('filtered BM25 leg keeps its graceful-degradation contract', () => {
  const db = getDb()
  seedThought({ id: 'bm25-degrade-hit', content: 'BM25_DEGRADE keyword match' })
  const brokenFilter = 'AND t.no_such_column = ? '

  expect(() => bm25ScoredIdsFiltered(db, 'BM25_DEGRADE', 10, brokenFilter, ['x'], true)).toThrow()
  expect(bm25ScoredIdsFiltered(db, 'BM25_DEGRADE', 10, brokenFilter, ['x']).map(r => r.id)).toEqual(
    bm25SearchIds(db, 'BM25_DEGRADE', 10)
  )
})

test('an empty filter delegates to the unfiltered leg', () => {
  const db = getDb()
  seedThought({ id: 'bm25-unfiltered-hit', content: 'BM25_UNFILTERED keyword match' })

  expect(bm25ScoredIdsFiltered(db, 'BM25_UNFILTERED', 10, '', []).map(r => r.id)).toEqual(
    bm25SearchIds(db, 'BM25_UNFILTERED', 10)
  )
})

const DIMENSIONS = 384

function seedVec(db: Database, id: string, vector: Float32Array): void {
  const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
  db.prepare(`INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, ?)`).run(
    id,
    buf,
    PROJECT
  )
}

function seedEmbeddedRankedProject(db: Database): void {
  const relevant = new Float32Array(DIMENSIONS)
  relevant[0] = 1

  seedRankedProject()
  for (let i = 0; i < 30; i++) {
    const weaker = new Float32Array(DIMENSIONS)
    weaker[0] = (30 - i) / 1000
    weaker[1] = 1
    seedVec(db, weakId(i), weaker)
  }
  seedVec(db, TARGET, relevant)
  // Hand-inserted vectors model "already embedded": the seeding trigger's pending
  // row would otherwise have the leg re-embed live from content instead.
  drainPendingEmbeddings([TARGET, ...Array.from({ length: 30 }, (_, i) => weakId(i))])
}

test.skipIf(!VEC_AVAILABLE)(
  'project-scoped hybrid search with both legs ranks the query thought first',
  () =>
    withVecDb(db => {
      seedEmbeddedRankedProject(db)
      const relevant = new Float32Array(DIMENSIONS)
      relevant[0] = 1

      const results = searchThoughts(db, {
        embedding: relevant,
        query: QUERY,
        topK: 10,
        hybrid: true,
        statusFilter: 'active',
        projectFilter: PROJECT
      })

      expect(results[0]?.thought.id).toBe(TARGET)
      expect(results[0].match_source).toEqual(['embedding', 'bm25'])
    })
)
