/**
 * Tests for the read-only placement proposer (`placement.ts`, task #945).
 *
 * Per the #945 handoff notes:
 *  - `deps.embed` + `deps.searchNeighbors` are stubbed, so no real vector
 *    index is required (the vec0 / `:memory:` caveat, AGENTS.md §8, is
 *    sidestepped: `createTestDb` is sufficient).
 *  - Stubbed neighbours must reference seeded *active, same-project,
 *    non-cluster* thoughts: pool membership enforces project scope, so any
 *    id not in the pool is structurally dropped by `findEmbeddingNeighborPairs`.
 *  - `proposePlacement` returns a `{ proposal, reason }` decision wrapper; on
 *    a hit `reason` equals the proposal's `rationale`.
 */

import { beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { closeDb, getDb } from '../../db'
import { config } from '../../config'
import { getThoughtRow } from '../../db/thoughts'
import { createTestDb, seedEdge, seedThought } from '../../test/helpers'
import { proposePlacement } from './placement'

beforeEach(createTestDb)
afterEach(closeDb)

// ── helpers ─────────────────────────────────────────────────────────────────

/** Deterministic embed stub: one zero vector per candidate text. */
function stubEmbed(): (texts: string[]) => Promise<Float32Array[]> {
  return async texts => texts.map(() => new Float32Array(384))
}

/**
 * `searchNeighbors` stub keyed by query thought id; unknown ids get no
 * neighbours. Seeded neighbours must exist in the pool (active, same-project,
 * non-cluster) or they are dropped by `findEmbeddingNeighborPairs`.
 */
function stubSearch(map: Record<string, Array<{ id: string; similarity: number }>>) {
  return (_id: string, _embedding: Float32Array) => map[_id] ?? []
}

// ── proposal fields ──────────────────────────────────────────────────────────

describe('proposePlacement', () => {
  describe('proposal fields', () => {
    test('confidence is clamped into [0,1]', async () => {
      const db = getDb()
      const n = seedThought({ content: 'chain neighbour' })
      const root = seedThought({ content: 'root' })
      const sourceId = seedThought({ content: 'source' })
      seedEdge(n, root, 'parent')
      const source = getThoughtRow(db, sourceId)!

      const over = await proposePlacement(
        source,
        {},
        { embed: stubEmbed(), searchNeighbors: stubSearch({ [sourceId]: [{ id: n, similarity: 1.4 }] }) },
        db
      )
      expect(over.proposal?.confidence).toBe(1) // 1.4 clamped down

      const zero = await proposePlacement(
        source,
        { minSimilarity: 0 },
        { embed: stubEmbed(), searchNeighbors: stubSearch({ [sourceId]: [{ id: n, similarity: 0 }] }) },
        db
      )
      expect(zero.proposal?.confidence).toBe(0)
    })
  })

  describe('maxClusterSize cap', () => {
    test('skips an oversized cluster with an explicit reason', async () => {
      const db = getDb()
      const clusterId = seedThought({ id: 'c-big', content: 'big cluster', is_cluster: 1, project_id: 'default' })
      const members = [1, 2, 3].map(i => seedThought({ content: `member ${i}` }))
      const sourceId = seedThought({ content: 'source' })
      for (const m of members) seedEdge(clusterId, m, 'cluster')
      const source = getThoughtRow(db, sourceId)!
      const result = await proposePlacement(
        source,
        { maxClusterSize: 3 },
        { embed: stubEmbed(), searchNeighbors: stubSearch({ [sourceId]: members.map(m => ({ id: m, similarity: 0.9 })) }) },
        db
      )
      expect(result.proposal).toBeNull()
      expect(result.reason).toContain('cluster c-big has 3 members >= maxClusterSize 3')
    })

    test('proposes a cluster just under the cap (boundary)', async () => {
      const db = getDb()
      const clusterId = seedThought({ id: 'c-small', content: 'small cluster', is_cluster: 1, project_id: 'default' })
      const members = [1, 2, 3].map(i => seedThought({ content: `member ${i}` }))
      const sourceId = seedThought({ content: 'source' })
      for (const m of members) seedEdge(clusterId, m, 'cluster')
      const source = getThoughtRow(db, sourceId)!
      const result = await proposePlacement(
        source,
        { maxClusterSize: 4 },
        { embed: stubEmbed(), searchNeighbors: stubSearch({ [sourceId]: members.map(m => ({ id: m, similarity: 0.9 })) }) },
        db
      )
      expect(result.proposal?.kind).toBe('cluster')
      expect(result.proposal?.target_id).toBe(clusterId)
    })

    test('the default cap is config.placement.maxClusterSize (50)', async () => {
      const db = getDb()
      expect(config.placement.maxClusterSize).toBe(50) // pin the reused default
      const clusterId = seedThought({ id: 'c-50', content: '50-member cluster', is_cluster: 1, project_id: 'default' })
      const members = Array.from({ length: 50 }, (_, i) => seedThought({ content: `m${i}` }))
      const sourceId = seedThought({ content: 'source' })
      for (const m of members) seedEdge(clusterId, m, 'cluster')
      const source = getThoughtRow(db, sourceId)!
      const result = await proposePlacement(
        source,
        {},
        { embed: stubEmbed(), searchNeighbors: stubSearch({ [sourceId]: members.map(m => ({ id: m, similarity: 0.9 })) }) },
        db
      )
      expect(result.proposal).toBeNull()
      expect(result.reason).toContain('>= maxClusterSize 50')
    })
  })

  describe('project isolation', () => {
    test('cross-project neighbours returned by the search stub are dropped', async () => {
      const db = getDb()
      const sourceId = seedThought({ content: 'source in default' })
      const otherN = seedThought({ content: 'neighbour in other', project_id: 'other' })
      const source = getThoughtRow(db, sourceId)!
      const result = await proposePlacement(
        source,
        {},
        { embed: stubEmbed(), searchNeighbors: stubSearch({ [sourceId]: [{ id: otherN, similarity: 0.95 }] }) },
        db
      )
      expect(result.proposal).toBeNull()
      expect(result.reason).toBe('no embedding neighbours above the similarity threshold')
    })

    test('a cluster from another project is filtered out of the majority counts', async () => {
      const db = getDb()
      const n1 = seedThought({ content: 'neighbour in default' })
      const otherCluster = seedThought({ id: 'c-other', content: 'other-project cluster', is_cluster: 1, project_id: 'other' })
      const sourceId = seedThought({ content: 'source in default' })
      seedEdge(otherCluster, n1, 'cluster') // edge crosses projects; lookup must not
      const source = getThoughtRow(db, sourceId)!
      const result = await proposePlacement(
        source,
        {},
        { embed: stubEmbed(), searchNeighbors: stubSearch({ [sourceId]: [{ id: n1, similarity: 0.9 }] }) },
        db
      )
      expect(result.proposal).toBeNull()
      expect(result.reason).toContain('no neighbour belongs to a cluster')
    })

    test('options.projectId re-scopes the candidate pool to another project', async () => {
      const db = getDb()
      const p2Cluster = seedThought({ id: 'c-p2', content: 'p2 cluster', is_cluster: 1, project_id: 'p2' })
      const n1 = seedThought({ content: 'p2 neighbour', project_id: 'p2' })
      seedEdge(p2Cluster, n1, 'cluster')
      const sourceId = seedThought({ content: 'source in default', project_id: 'default' })
      const source = getThoughtRow(db, sourceId)!
      const deps = { embed: stubEmbed(), searchNeighbors: stubSearch({ [sourceId]: [{ id: n1, similarity: 0.9 }] }) }

      // default scope = the source's own project: the p2 neighbour is not in the pool
      const defaultScope = await proposePlacement(source, {}, deps, db)
      expect(defaultScope.proposal).toBeNull()
      expect(defaultScope.reason).toBe('no embedding neighbours above the similarity threshold')

      // explicit re-scope: the p2 pool includes the neighbour → the cluster applies
      const p2Scope = await proposePlacement(source, { projectId: 'p2' }, deps, db)
      expect(p2Scope.proposal?.kind).toBe('cluster')
      expect(p2Scope.proposal?.target_id).toBe(p2Cluster)
    })
  })
})
