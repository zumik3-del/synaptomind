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
import { getThoughtRow } from '../../db/thoughts'
import { createTestDb, seedEdge, seedThought } from '../../test/helpers'
import { proposePlacement, type PlacementDecision } from './placement'

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

/** AC: every proposal carries a non-empty rationale, confidence ∈ [0,1], review_required. */
function assertProposalFields(p: NonNullable<PlacementDecision['proposal']>) {
  expect(typeof p.rationale).toBe('string')
  expect(p.rationale.length).toBeGreaterThan(0)
  expect(p.confidence).toBeGreaterThanOrEqual(0)
  expect(p.confidence).toBeLessThanOrEqual(1)
  expect(p.review_required).toBeTrue()
}

/** Seed a strict-majority fixture: two neighbours in one cluster + a source. */
function seedMajorityFixture(): [string, string, string, string] {
  const clusterId = seedThought({ id: 'c-major', content: 'majority cluster', is_cluster: 1, project_id: 'default' })
  const n1 = seedThought({ content: 'neighbour one' })
  const n2 = seedThought({ content: 'neighbour two' })
  const sourceId = seedThought({ content: 'source thought' })
  seedEdge(clusterId, n1, 'cluster')
  seedEdge(clusterId, n2, 'cluster')
  return [clusterId, n1, n2, sourceId]
}

// ── branch selection with stub neighbours ─────────────────────────────────

describe('proposePlacement', () => {
  describe('stub neighbours: branch selection', () => {
    test('proposes the cluster that holds the majority of clustered neighbours', async () => {
      const db = getDb()
      const [clusterId, n1, n2, sourceId] = seedMajorityFixture()
      const source = getThoughtRow(db, sourceId)!
      const result = await proposePlacement(
        source,
        {},
        { embed: stubEmbed(), searchNeighbors: stubSearch({ [sourceId]: [{ id: n1, similarity: 0.9 }, { id: n2, similarity: 0.8 }] }) },
        db
      )
      expect(result.proposal).not.toBeNull()
      expect(result.proposal!.kind).toBe('cluster')
      expect(result.proposal!.target_id).toBe(clusterId)
      // share = 2/2 = 1, avgSim = (0.9 + 0.8) / 2 = 0.85 → 0.5·1 + 0.5·0.85
      expect(result.proposal!.confidence).toBeCloseTo(0.925)
      expect(result.proposal!.rationale).toContain('cluster majority: 2/2')
      expect(result.proposal!.rationale).toContain(clusterId)
      assertProposalFields(result.proposal!)
      expect(result.reason).toBe(result.proposal!.rationale)
    })

    test('a cluster tie (1 v 1) is not a strict majority: falls through', async () => {
      const db = getDb()
      const c1 = seedThought({ id: 'c1', content: 'cluster one', is_cluster: 1, project_id: 'default' })
      const c2 = seedThought({ id: 'c2', content: 'cluster two', is_cluster: 1, project_id: 'default' })
      const n1 = seedThought({ content: 'member of c1' })
      const n2 = seedThought({ content: 'member of c2' })
      const sourceId = seedThought({ content: 'source' })
      seedEdge(c1, n1, 'cluster')
      seedEdge(c2, n2, 'cluster')
      const source = getThoughtRow(db, sourceId)!
      const result = await proposePlacement(
        source,
        {},
        { embed: stubEmbed(), searchNeighbors: stubSearch({ [sourceId]: [{ id: n1, similarity: 0.9 }, { id: n2, similarity: 0.85 }] }) },
        db
      )
      expect(result.proposal).toBeNull()
      expect(result.reason).toContain('no cluster majority')
    })

    test('proposes the nearest neighbour participating in a parent chain', async () => {
      const db = getDb()
      const n1 = seedThought({ content: 'neighbour without chain' })
      const root = seedThought({ content: 'chain root' })
      const n2 = seedThought({ content: 'neighbour in chain' })
      const sourceId = seedThought({ content: 'source' })
      seedEdge(n1, sourceId, 'related') // non-hierarchy edge: must not qualify
      seedEdge(root, n2, 'parent')
      const source = getThoughtRow(db, sourceId)!
      const result = await proposePlacement(
        source,
        {},
        { embed: stubEmbed(), searchNeighbors: stubSearch({ [sourceId]: [{ id: n1, similarity: 0.95 }, { id: n2, similarity: 0.8 }] }) },
        db
      )
      expect(result.proposal).not.toBeNull()
      expect(result.proposal!.kind).toBe('parent')
      expect(result.proposal!.target_id).toBe(n2) // nearest qualifying neighbour, not the closest overall
      expect(result.proposal!.confidence).toBeCloseTo(0.8)
      expect(result.proposal!.rationale).toContain('parent/develops chain')
      assertProposalFields(result.proposal!)
    })

    test('a develops edge also qualifies a neighbour for the parent branch', async () => {
      const db = getDb()
      const n1 = seedThought({ content: 'evolving neighbour' })
      const root = seedThought({ content: 'root' })
      const sourceId = seedThought({ content: 'source' })
      seedEdge(n1, root, 'develops')
      const source = getThoughtRow(db, sourceId)!
      const result = await proposePlacement(
        source,
        {},
        { embed: stubEmbed(), searchNeighbors: stubSearch({ [sourceId]: [{ id: n1, similarity: 0.9 }] }) },
        db
      )
      expect(result.proposal?.kind).toBe('parent')
      expect(result.proposal?.target_id).toBe(n1)
      expect(result.reason).toBe(result.proposal!.rationale)
    })

    test('null branch: joined skip reasons when neither cluster nor chain applies', async () => {
      const db = getDb()
      const n1 = seedThought({ content: 'plain neighbour' })
      const sourceId = seedThought({ content: 'source' })
      const source = getThoughtRow(db, sourceId)!
      const result = await proposePlacement(
        source,
        {},
        { embed: stubEmbed(), searchNeighbors: stubSearch({ [sourceId]: [{ id: n1, similarity: 0.9 }] }) },
        db
      )
      expect(result.proposal).toBeNull()
      expect(result.reason).toContain('no neighbour belongs to a cluster')
      expect(result.reason).toContain('no parent/develops chain node among the embedding neighbours')
    })
  })

  describe('null / degraded branches', () => {
    test('returns null when no neighbour clears the similarity threshold', async () => {
      const db = getDb()
      const sourceId = seedThought({ content: 'source' })
      const source = getThoughtRow(db, sourceId)!
      const result = await proposePlacement(source, {}, { embed: stubEmbed(), searchNeighbors: stubSearch({}) }, db)
      expect(result).toEqual({ proposal: null, reason: 'no embedding neighbours above the similarity threshold' })
    })

    test('returns null immediately when the source is a cluster thought', async () => {
      const db = getDb()
      const clusterId = seedThought({ id: 'c-src', content: 'source cluster', is_cluster: 1, project_id: 'default' })
      let embedCalls = 0
      const source = getThoughtRow(db, clusterId)!
      const result = await proposePlacement(
        source,
        {},
        {
          embed: async () => {
            embedCalls += 1
            return []
          },
          searchNeighbors: stubSearch({})
        },
        db
      )
      expect(result).toEqual({ proposal: null, reason: 'source is a cluster thought' })
      expect(embedCalls).toBe(0) // short-circuits before embedding
    })

    test('returns null when the embedder is unavailable (throws)', async () => {
      const db = getDb()
      const sourceId = seedThought({ content: 'source' })
      const source = getThoughtRow(db, sourceId)!
      const result = await proposePlacement(
        source,
        {},
        {
          embed: async () => {
            throw new Error('embedder exploded')
          },
          searchNeighbors: stubSearch({})
        },
        db
      )
      expect(result).toEqual({ proposal: null, reason: 'embedder unavailable' })
    })

    test('returns null when the embedder returns a mismatched vector count', async () => {
      const db = getDb()
      const sourceId = seedThought({ content: 'source' })
      seedThought({ content: 'second active thought' }) // pool = 2 candidates
      const source = getThoughtRow(db, sourceId)!
      const result = await proposePlacement(
        source,
        {},
        { embed: async () => [new Float32Array(384)], searchNeighbors: stubSearch({}) }, // 1 vector for 2 candidates
        db
      )
      expect(result).toEqual({ proposal: null, reason: 'embedder returned a mismatched number of vectors' })
    })

    test('considers a draft source (the source is unshifted into the pool)', async () => {
      const db = getDb()
      const n1 = seedThought({ content: 'neighbour in chain' })
      const root = seedThought({ content: 'root' })
      const sourceId = seedThought({ content: 'draft source', status: 'draft' })
      seedEdge(n1, root, 'develops')
      const source = getThoughtRow(db, sourceId)!
      const result = await proposePlacement(
        source,
        {},
        { embed: stubEmbed(), searchNeighbors: stubSearch({ [sourceId]: [{ id: n1, similarity: 0.9 }] }) },
        db
      )
      expect(result.proposal?.kind).toBe('parent')
      expect(result.proposal?.target_id).toBe(n1)
    })
  })
})
