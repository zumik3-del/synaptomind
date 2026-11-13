import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { closeDb } from '../db/init'
import { pairKey } from '../db/utils'
import { config } from '../config'
import { createTestDb, drainPendingEmbeddings, seedThought, withVecDb } from '../test/helpers'
import type { ClusterCandidate } from '../db/thoughts'
import { findComponents, groupCandidates } from './auto-cluster.service'
import {
  buildInMemoryDistanceLookup,
  buildInMemoryNeighborLookup,
  findEmbeddingNeighborPairs,
  type SearchNeighborsFn
} from './edge-candidates.service'
import { proposePlacementPlan } from './placement/engine'

beforeEach(createTestDb)
afterEach(closeDb)

function unitAt(angle: number): Float32Array {
  const v = new Float32Array(384)
  v[0] = Math.cos(angle)
  v[1] = Math.sin(angle)
  return v
}

function candidatesAt(angles: number[]): Array<{ id: string; content: string }> {
  return angles.map((_, i) => ({ id: `A${i}`, content: `content ${i}` }))
}

function idsOf(neighbors: Array<{ id: string }>): Set<string> {
  return new Set(neighbors.map(n => n.id))
}

type Pair = { source_id: string; target_id: string }

function pairSet(pairs: Pair[]): Set<string> {
  return new Set(pairs.map(p => pairKey(p.source_id, p.target_id)))
}

describe('AC8: the skip-sort fast path returns the same neighbours as the sorted path', () => {
  test('distance lookup: k >= others.length keeps every neighbour with a real distance', () => {
    const angles = [0, 0.2, 0.45, 0.5, 0.75, 1]
    const candidates = candidatesAt(angles)
    const embeddings = angles.map(unitAt)
    const lookup = buildInMemoryDistanceLookup(candidates, embeddings)

    const fast = lookup('A0', 5)
    const sorted = lookup('A0', 2)

    expect(idsOf(fast)).toEqual(new Set(['A1', 'A2', 'A3', 'A4', 'A5']))
    expect(fast).toHaveLength(5)
    fast.forEach(n => {
      const j = Number(n.id.slice(1))
      expect(n.distance).toBeCloseTo(1 - Math.cos(angles[j]!), 3)
    })
    expect(sorted.map(n => n.id)).toEqual(['A1', 'A2'])
    for (const n of sorted) expect(idsOf(fast).has(n.id)).toBe(true)
  })

  test('distance lookup: fast path and sorted path agree exactly when all distances tie', () => {
    const candidates = candidatesAt([0, 0, 0, 0])
    const embeddings = [unitAt(0), unitAt(0), unitAt(0), unitAt(0)]
    const distanceLookup = buildInMemoryDistanceLookup(candidates, embeddings)

    const fast = distanceLookup('A0', 4)
    const sliced = distanceLookup('A0', 3)

    expect(idsOf(fast)).toEqual(new Set(['A1', 'A2', 'A3']))
    expect(fast.every(n => n.distance === 0)).toBe(true)
    expect(idsOf(sliced)).toEqual(new Set(['A1', 'A2', 'A3']))
    for (const n of sliced) expect(idsOf(fast).has(n.id)).toBe(true)

    const similarityLookup = buildInMemoryNeighborLookup(candidates, embeddings)
    expect(idsOf(similarityLookup('A0', embeddings[0]!, 4))).toEqual(new Set(['A1', 'A2', 'A3']))
    expect(idsOf(similarityLookup('A0', embeddings[0]!, 2))).toEqual(new Set(['A1', 'A2']))
  })

  test('similarity lookup: the auto-cluster-legal k = N-1 returns the full neighbour set', () => {
    const angles = [0, 0.1, 0.3, 0.7, 1.2]
    const candidates = candidatesAt(angles)
    const embeddings = angles.map(unitAt)
    const lookup = buildInMemoryNeighborLookup(candidates, embeddings)

    for (const i of [0, 2, 4]) {
      const id = `A${i}`
      const full = lookup(id, embeddings[i]!, candidates.length - 1)
      expect(full).toHaveLength(candidates.length - 1)
      expect(idsOf(full)).toEqual(new Set(candidates.filter(c => c.id !== id).map(c => c.id)))
    }
  })

  test('auto-cluster group composition is identical for the fast and sorted shapes (production groupCandidates)', () => {
    const angles = [0, 0.1, 0.53, 1]
    const candidates: ClusterCandidate[] = angles.map((_, i) => ({
      id: `A${i}`,
      content: `content ${i}`,
      status: 'active',
      tags: [],
      source: null,
      project_id: 'default',
      created_at: new Date(Date.now() - (10 - i) * 86400000).toISOString()
    }))
    const lookup = buildInMemoryDistanceLookup(candidatesAt(angles), angles.map(unitAt))
    const neighborFn =
      (minSimilarity: number) =>
      (id: string): string[] =>
        lookup(id, candidates.length)
          .filter(n => n.distance < minSimilarity)
          .map(n => n.id)

    const a0 = Object.fromEntries(lookup('A0', 3).map(n => [n.id, n.distance]))
    expect(a0.A1!).toBeCloseTo(0.005, 3)
    expect(a0.A2!).toBeGreaterThan(0.09)
    expect(a0.A2!).toBeLessThan(0.3)
    const a1 = Object.fromEntries(lookup('A1', 3).map(n => [n.id, n.distance]))
    expect(a1.A2!).toBeGreaterThan(0.085)
    expect(a1.A2!).toBeLessThan(0.1084)
    const a2 = Object.fromEntries(lookup('A2', 3).map(n => [n.id, n.distance]))
    expect(a2.A3!).toBeGreaterThan(0.09)
    expect(a2.A3!).toBeLessThan(0.12)

    expect(groupCandidates(candidates, neighborFn(0.09), 3)).toEqual([])

    const wide = groupCandidates(candidates, neighborFn(0.1), 3)
    expect(wide).toHaveLength(1)
    expect(wide[0]!.slice().sort()).toEqual(['A0', 'A1', 'A2'])

    const reference = findComponents(
      [
        ['A0', 'A1'],
        ['A1', 'A2']
      ],
      candidates.map(c => c.id)
    ).filter(g => g.length >= 3)
    expect(reference).toEqual([['A0', 'A1', 'A2']])
    expect(wide).toEqual(reference)

    const truncated = (id: string): string[] =>
      lookup(id, candidates.length)
        .slice()
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 1)
        .filter(n => n.distance < 0.006)
        .map(n => n.id)
    expect(groupCandidates(candidates, truncated, 3)).toEqual([])
  })
})

function seedSupersetCandidates(db: Database, angles: number[]): string[] {
  const past = new Date(Date.now() - 10 * 86400000).toISOString()
  const ids = angles.map((_, i) =>
    seedThought({ content: `superset candidate ${i}`, created_at: past })
  )
  for (let i = 0; i < ids.length; i++) {
    const v = unitAt(angles[i]!)
    db.prepare(`INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, 'default')`).run(
      ids[i]!,
      Buffer.from(v.buffer as ArrayBuffer, v.byteOffset, v.byteLength)
    )
  }
  drainPendingEmbeddings(ids)
  return ids
}

const CANDIDATE_COUNT = 24
const AC9_DECOYS = 1200
const AC9_ANGLES: number[] = [
  0,
  ...Array.from({ length: CANDIDATE_COUNT - 1 }, (_, i) => 0.001 + i * 0.0025)
]
const AC9_DECOYS_BY_ANGLE: Array<{ id: string; angle: number }> = Array.from(
  { length: AC9_DECOYS },
  (_, i) => ({
    id: `DECOY${i}`,
    angle: 0.0002 + i * ((0.05 - 0.0002) / (AC9_DECOYS - 1))
  })
)
const AC9_UNIVERSE: Array<{ id: string; angle: number }> = [
  ...AC9_ANGLES.map((angle, i) => ({ id: `A${i}`, angle })),
  ...AC9_DECOYS_BY_ANGLE
]

function poolCappedLookup(pool: number, topK: number, universe = AC9_UNIVERSE): SearchNeighborsFn {
  const vectors = new Map(universe.map(u => [u.id, unitAt(u.angle)]))
  return (candidateId, embedding, _topK) =>
    universe
      .map(u => {
        const v = vectors.get(u.id)!
        let dot = 0
        for (let k = 0; k < embedding.length; k++) dot += embedding[k]! * v[k]!
        return { id: u.id, similarity: dot }
      })
      .filter(n => n.id !== candidateId)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, pool)
      .slice(0, topK)
}

function uuidUniverse(ids: string[], angles: number[]): Array<{ id: string; angle: number }> {
  const universe = ids.map((id, i) => ({ id, angle: angles[i]! }))
  return [...universe, ...AC9_DECOYS_BY_ANGLE]
}

describe('AC9: the candidate-local lookup is a superset of the pool-capped index lookup', () => {
  test('pure lookup: the old pool drops candidate pairs, the in-memory lookup keeps every one', () => {
    const candidates = AC9_ANGLES.map((_, i) => ({ id: `A${i}`, content: `content ${i}` }))
    const embeddings = AC9_ANGLES.map(unitAt)
    const minSimilarity = 0.99
    const topK = 10
    const pool = Math.min(1000, topK * 10)

    const oldPairs = findEmbeddingNeighborPairs(
      candidates,
      embeddings,
      minSimilarity,
      poolCappedLookup(pool, topK),
      topK
    )
    const newPairs = findEmbeddingNeighborPairs(
      candidates,
      embeddings,
      minSimilarity,
      buildInMemoryNeighborLookup(candidates, embeddings),
      topK
    )
    const oldSet = pairSet(oldPairs)
    const newSet = pairSet(newPairs)

    const poolOfA0 = poolCappedLookup(pool, topK)('A0', embeddings[0]!, topK).map(n => n.id)
    expect(poolOfA0.every(id => id.startsWith('A') || id.startsWith('DECOY'))).toBe(true)

    expect(newSet.size).toBeGreaterThan(0)
    expect(oldSet.size).toBeGreaterThan(0)
    for (const key of oldSet) expect(newSet.has(key)).toBe(true)
    const onlyNew = [...newSet].filter(k => !oldSet.has(k))
    const onlyOld = [...oldSet].filter(k => !newSet.has(k))
    expect(onlyOld).toEqual([])
    expect(onlyNew.length).toBeGreaterThan(0)
  })

  test('proposals: the extra pair is a real placement-engine edge proposal, and no old pair is lost', async () => {
    await withVecDb(async db => {
      const ids = seedSupersetCandidates(db, AC9_ANGLES)
      const topK = 10
      const options = { minSimilarity: 0.99, topK, maxProposals: 500, maxCandidates: 500 }
      expect(config.edgeDetect.topK).toBe(topK)

      const result = await proposePlacementPlan({ thoughtId: ids[0]! }, options, {
        embed: async () => []
      })
      const oldResult = await proposePlacementPlan({ thoughtId: ids[0]! }, options, {
        embed: async () => [],
        searchNeighbors: poolCappedLookup(
          Math.min(1000, topK * 10),
          topK,
          uuidUniverse(ids, AC9_ANGLES)
        )
      })

      expect(result.degraded).toBe(false)
      const proposed = new Set(result.edges.map(p => pairKey(p.source_id, p.target_id)))
      const oldProposed = new Set(oldResult.edges.map(p => pairKey(p.source_id, p.target_id)))
      for (const key of oldProposed) expect(proposed.has(key)).toBe(true)
      const onlyNew = [...proposed].filter(k => !oldProposed.has(k))
      expect(onlyNew.length).toBeGreaterThan(0)
      expect(oldProposed.size).toBe(0)
      expect(proposed.size).toBeGreaterThan(0)
      expect(result.edges.every(p => p.review_required && p.type === 'related')).toBe(true)
    })
  })

  test('auto-cluster is unaffected: it asks for k = N-1, which both shapes answer completely', () => {
    const candidates: ClusterCandidate[] = AC9_ANGLES.map((_, i) => ({
      id: `A${i}`,
      content: `content ${i}`,
      status: 'active',
      tags: [],
      source: null,
      project_id: 'default',
      created_at: new Date(Date.now() - (40 - i) * 86400000).toISOString()
    }))
    const embeddings = AC9_ANGLES.map(unitAt)
    const k = candidates.length
    const oldUniverse: Array<{ id: string; angle: number }> = AC9_ANGLES.map((angle, i) => ({
      id: `A${i}`,
      angle
    }))
    const oldShape = new Set(
      findEmbeddingNeighborPairs(
        candidates,
        embeddings,
        0.99,
        poolCappedLookup(Math.min(1000, k * 10), k, oldUniverse),
        k
      ).map(p => pairKey(p.source_id, p.target_id))
    )
    const newShape = new Set(
      findEmbeddingNeighborPairs(
        candidates,
        embeddings,
        0.99,
        buildInMemoryNeighborLookup(candidates, embeddings),
        k
      ).map(p => pairKey(p.source_id, p.target_id))
    )
    expect(newShape.size).toBeGreaterThan(0)
    expect(oldShape).toEqual(newShape)

    const neighborFn =
      (pairs: Set<string>) =>
      (id: string): string[] =>
        [...pairs]
          .filter(key => key.split('::').includes(id))
          .map(key => key.split('::').find(x => x !== id)!)
    expect(groupCandidates(candidates, neighborFn(newShape), 2)).toEqual(
      groupCandidates(candidates, neighborFn(oldShape), 2)
    )
  })
})
