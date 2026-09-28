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
import type { Database } from 'bun:sqlite'
import { closeDb, getDb } from '../../db'
import { config } from '../../config'
import { getThoughtRow } from '../../db/thoughts'
import { createTestDb, seedEdge, seedThought } from '../../test/helpers'
import { proposePlacement } from './placement'

beforeEach(createTestDb)
afterEach(closeDb)

// ── helpers ─────────────────────────────────────────────────────────────────

/** Deterministic embed stub: one zero vector per candidate text. */
function stubEmbed(recordLengths?: number[]): (texts: string[]) => Promise<Float32Array[]> {
  return async texts => {
    recordLengths?.push(texts.length)
    return texts.map(() => new Float32Array(384))
  }
}

/**
 * `searchNeighbors` stub keyed by query thought id; unknown ids get no
 * neighbours. Seeded neighbours must exist in the pool (active, same-project,
 * non-cluster) or they are dropped by `findEmbeddingNeighborPairs`.
 */
function stubSearch(map: Record<string, Array<{ id: string; similarity: number }>>, recordTopK?: number[]) {
  return (_id: string, _embedding: Float32Array, topK: number) => {
    recordTopK?.push(topK)
    return map[_id] ?? []
  }
}

/** Snapshot of the mutable tables the proposer must never write (ADR §2.4). */
function tableFingerprint(db: Database): Record<string, number> {
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  return {
    projects: count('projects'),
    thoughts: count('thoughts'),
    edges: count('edges'),
    tags: count('tags'),
    thought_tags: count('thought_tags'),
    thought_importance: count('thought_importance')
  }
}

// ── config defaults reuse (edgeDetect.*) ─────────────────────────────────────

describe('proposePlacement', () => {
  describe('config defaults reuse (edgeDetect.*)', () => {
    test('default minSimilarity (0.75) filters low-similarity neighbours; override changes the outcome', async () => {
      const db = getDb()
      const c1 = seedThought({ id: 'c1', content: 'one', is_cluster: 1, project_id: 'default' })
      const c2 = seedThought({ id: 'c2', content: 'two', is_cluster: 1, project_id: 'default' })
      const nHigh = seedThought({ content: 'high-sim neighbour' })
      const nLow = seedThought({ content: 'low-sim neighbour' })
      const sourceId = seedThought({ content: 'source' })
      seedEdge(c1, nHigh, 'cluster')
      seedEdge(c2, nLow, 'cluster')
      const source = getThoughtRow(db, sourceId)!
      const deps = {
        embed: stubEmbed(),
        searchNeighbors: stubSearch({ [sourceId]: [{ id: nHigh, similarity: 0.8 }, { id: nLow, similarity: 0.74 }] })
      }

      // default threshold 0.75 drops nLow (0.74): only nHigh → c1 majority
      const atDefault = await proposePlacement(source, {}, deps, db)
      expect(atDefault.proposal?.kind).toBe('cluster')
      expect(atDefault.proposal?.target_id).toBe(c1)

      // lowered threshold keeps both: 1 v 1 tie → no majority
      const lowered = await proposePlacement(source, { minSimilarity: 0.5 }, deps, db)
      expect(lowered.proposal).toBeNull()
      expect(lowered.reason).toContain('no cluster majority')
    })

    test('default topK and maxCandidates come from config.edgeDetect', async () => {
      const db = getDb()
      const topKSeen: number[] = []
      const sourceId = seedThought({ content: 'source' })
      const source = getThoughtRow(db, sourceId)!
      const search = stubSearch({}, topKSeen)
      await proposePlacement(source, {}, { embed: stubEmbed(), searchNeighbors: search }, db)
      expect(topKSeen.length).toBeGreaterThan(0)
      expect(new Set(topKSeen)).toEqual(new Set([config.edgeDetect.topK])) // 10

      // maxCandidates bounds the pool: 105 active thoughts, limit = 100
      const embedLengths: number[] = []
      const base = Date.now()
      for (let i = 0; i < 105; i++) {
        seedThought({ content: `bulk ${i}`, created_at: new Date(base - i * 60_000).toISOString() })
      }
      const bulkSource = getThoughtRow(db, sourceId)! // newest, always inside the limit window
      await proposePlacement(bulkSource, {}, { embed: stubEmbed(embedLengths), searchNeighbors: stubSearch({}) }, db)
      expect(embedLengths).toEqual([config.edgeDetect.maxCandidates]) // 100
    })
  })

  describe('read-only guarantee', () => {
    test('no edge/cluster/lifecycle mutation occurs on any branch', async () => {
      const db = getDb()
      const clusterId = seedThought({ id: 'c-ro', content: 'ro cluster', is_cluster: 1, project_id: 'default' })
      const n1 = seedThought({ content: 'ro neighbour (clustered + chained)' })
      const n2 = seedThought({ content: 'ro neighbour (chain only)' })
      const root = seedThought({ content: 'ro root' })
      const srcA = seedThought({ content: 'source: cluster hit' })
      const srcB = seedThought({ content: 'source: cap skip' })
      const srcC = seedThought({ content: 'source: parent hit' })
      const srcD = seedThought({ content: 'source: no neighbours' })
      const srcE = seedThought({ content: 'source: embedder failure' })
      seedEdge(clusterId, n1, 'cluster')
      seedEdge(root, n1, 'parent')
      seedEdge(root, n2, 'parent')

      const neighbours = (id: string, target: string) => ({ [id]: [{ id: target, similarity: 0.9 }] })
      const before = tableFingerprint(db)
      const results = await Promise.all([
        proposePlacement(getThoughtRow(db, srcA)!, {}, { embed: stubEmbed(), searchNeighbors: stubSearch(neighbours(srcA, n1)) }, db),
        proposePlacement(getThoughtRow(db, srcB)!, { maxClusterSize: 1 }, { embed: stubEmbed(), searchNeighbors: stubSearch(neighbours(srcB, n1)) }, db),
        proposePlacement(getThoughtRow(db, srcC)!, {}, { embed: stubEmbed(), searchNeighbors: stubSearch(neighbours(srcC, n2)) }, db),
        proposePlacement(getThoughtRow(db, srcD)!, {}, { embed: stubEmbed(), searchNeighbors: stubSearch({}) }, db),
        proposePlacement(
          getThoughtRow(db, srcE)!,
          {},
          {
            embed: async () => {
              throw new Error('embedder down')
            },
            searchNeighbors: stubSearch({})
          },
          db
        )
      ])

      // each branch reached the intended path
      // note: null?.kind is undefined, so the null-proposal cases appear as undefined
      expect(results.map(r => r.proposal?.kind)).toEqual(['cluster', 'parent', 'parent', undefined, undefined])
      expect(results[3].reason).toBe('no embedding neighbours above the similarity threshold')
      expect(results[4].reason).toBe('embedder unavailable')
      // and nothing was written on any of them
      expect(tableFingerprint(db)).toEqual(before)
    })
  })
})
