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

/**
 * One project where the query is a thought's own content, inserted after 30
 * weaker matches. The planner drives the filtered leg from `thoughts` (the
 * indexed `t.status` predicate invites it), so insertion order used to decide
 * both the row order and which rows survived the cap.
 *
 * Each weak row matches only `alpha` and carries one filler token more than the
 * row before it, so its BM25 score is strictly lower than its predecessor's: the
 * 30 weak rows are distinct candidates, never one tie group, so "any 9 of them"
 * cannot stand in for the true top under the cap.
 */
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

/** Target first, then the weak rows in their strictly decreasing relevance order. */
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

  // The unfiltered leg is the score-ordered oracle: this fixture is one project.
  const best = bm25ScoredIdsFiltered(db, QUERY, 1000, '', []).slice(0, 10)
  // No tie group can hide a wrong selection: all 30 weak scores are distinct.
  expect(new Set(best.map(r => r.score)).size).toBe(best.length)

  const capped = bm25ScoredIdsFiltered(db, QUERY, 10, filter.sql, filter.params)

  expect(capped.map(r => r.id)).toEqual(best.map(r => r.id))
  expect(capped.map(r => r.id)).toEqual(expectedTopIds(10))
})

test('equal scores break on thought_id, so a tie straddling the cap is stable', () => {
  const db = getDb()
  // Identical content means identical bm25(); inserted in reverse id order so the
  // planner's row order cannot masquerade as the tie order.
  const later = seedThought({ id: 'bm25-tie-z', project_id: PROJECT, content: 'tie probe' })
  const earlier = seedThought({ id: 'bm25-tie-a', project_id: PROJECT, content: 'tie probe' })
  const filter = serviceFilter()

  const [first, second] = bm25ScoredIdsFiltered(db, 'tie probe', 2, filter.sql, filter.params)
  expect(first.score).toBe(second.score)

  for (let run = 0; run < 5; run++) {
    const both = bm25ScoredIdsFiltered(db, 'tie probe', 2, filter.sql, filter.params)
    expect(both.map(r => r.id)).toEqual([earlier, later])
    // The tie straddles the outer cut: the survivor is the id-ordered one, not the planner's.
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

/** The target matches the query exactly; the weaker matches trail it by a hair. */
function seedEmbeddedRankedProject(db: Database): void {
  const relevant = new Float32Array(DIMENSIONS)
  relevant[0] = 1

  seedRankedProject()
  for (let i = 0; i < 30; i++) {
    // A strictly decreasing resemblance keeps the vector leg in insertion order,
    // so both legs agree on the weaker rows and only their shared top can win.
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
