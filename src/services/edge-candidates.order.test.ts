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

/**
 * Task #1570 — AC8 (skip-sort fast path) and AC9 (superset claim) pins for the
 * candidate-local neighbour lookup introduced by #1566/#1569.
 *
 * AC8: the lookup returns its untruncated neighbour list WITHOUT sorting when
 * `k >= others.length` (auto-cluster always asks k = N-1). Both consumers are
 * order-independent, so the fast path must change cost only, never a result.
 *
 * AC9: the lookup ranks the whole candidate set, whereas the vec0 lookup it
 * replaces (`searchThoughts`, `pool = min(1000, topK*10)`) ranked the whole
 * INDEX and then filtered down to candidates — deliberately a superset. The
 * tests below construct a fixture where that superset is observable, and pin the
 * boundary at which it is not, so the claim is stated with its real reach.
 */

beforeEach(createTestDb)
afterEach(closeDb)

/** Unit vector in the `[cos, sin]` plane, so every pairwise cosine is exact. */
function unitAt(angle: number): Float32Array {
  const v = new Float32Array(384)
  v[0] = Math.cos(angle)
  v[1] = Math.sin(angle)
  return v
}

/** Candidate ids `A0..A(n-1)`, one per supplied angle. */
function candidatesAt(angles: number[]): Array<{ id: string; content: string }> {
  return angles.map((_, i) => ({ id: `A${i}`, content: `content ${i}` }))
}

function idsOf(neighbors: Array<{ id: string }>): Set<string> {
  return new Set(neighbors.map(n => n.id))
}

/** Structural pair shape — `EmbeddingNeighborPair` is deliberately not exported. */
type Pair = { source_id: string; target_id: string }

function pairSet(pairs: Pair[]): Set<string> {
  return new Set(pairs.map(p => pairKey(p.source_id, p.target_id)))
}

// ── AC8 skip-sort fast path ───────────────────────────────────────────────────

describe('AC8: the skip-sort fast path returns the same neighbours as the sorted path', () => {
  test('distance lookup: k >= others.length keeps every neighbour with a real distance', () => {
    // Distinct pairwise distances, so a truncated result has exactly one order.
    const angles = [0, 0.2, 0.45, 0.5, 0.75, 1]
    const candidates = candidatesAt(angles)
    const embeddings = angles.map(unitAt)
    const lookup = buildInMemoryDistanceLookup(candidates, embeddings)

    // k = 5 >= others.length = 5 → fast path (no sort); k = 2 → sorted + sliced.
    const fast = lookup('A0', 5)
    const sorted = lookup('A0', 2)

    expect(idsOf(fast)).toEqual(new Set(['A1', 'A2', 'A3', 'A4', 'A5']))
    expect(fast).toHaveLength(5)
    // Every neighbour still carries its `1 - cos` distance — not a truncated or
    // defaulted value.
    fast.forEach(n => {
      const j = Number(n.id.slice(1))
      expect(n.distance).toBeCloseTo(1 - Math.cos(angles[j]!), 3)
    })
    // The sorted path is the truncation of the fast path's data.
    expect(sorted.map(n => n.id)).toEqual(['A1', 'A2'])
    for (const n of sorted) expect(idsOf(fast).has(n.id)).toBe(true)
  })

  test('distance lookup: fast path and sorted path agree exactly when all distances tie', () => {
    // Every candidate sits at the same vector, so all distances are 0 and the
    // sorted path's ordering is arbitrary. Sets must match regardless.
    const candidates = candidatesAt([0, 0, 0, 0])
    const embeddings = [unitAt(0), unitAt(0), unitAt(0), unitAt(0)]
    const distanceLookup = buildInMemoryDistanceLookup(candidates, embeddings)

    const fast = distanceLookup('A0', 4) // k >= others.length → skip sort
    const sliced = distanceLookup('A0', 3) // sort + slice

    expect(idsOf(fast)).toEqual(new Set(['A1', 'A2', 'A3']))
    expect(fast.every(n => n.distance === 0)).toBe(true)
    expect(idsOf(sliced)).toEqual(new Set(['A1', 'A2', 'A3']))
    // A larger k can never lose a neighbour of a smaller k.
    for (const n of sliced) expect(idsOf(fast).has(n.id)).toBe(true)

    // Same for the similarity flavour (no sort at k = N-1, sorted at k = 2).
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
    // Angles picked from the MEASURED `1 - cos` distances of these Float32
    // vectors (the two-component unit vectors are only ~1e-3 exact after
    // `Float32Array` rounding, so the bands are asserted against what the lookup
    // actually returns): A0-A1 0.0050 / A1-A2 0.0910 / A2-A3 0.1084 /
    // A0-A2 0.1372 / A1-A3 0.3784 / A0-A3 0.4597.
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
    /** The auto-cluster neighbourFn: full lookup (k = N-1, fast path) + threshold. */
    const neighborFn = (minSimilarity: number) => (id: string): string[] =>
      lookup(id, candidates.length)
        .filter(n => n.distance < minSimilarity)
        .map(n => n.id)

    // Precondition: the measured bands the thresholds below cut through.
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

    // Two cuts either side of the A1-A2 / A0-A2 band (0.0910 vs 0.1372): 0.09
    // keeps only the A0-A1 link, so nothing reaches minMembers = 3 — while 0.10
    // promotes the A0-A1-A2 component and still leaves A0-A2/A2-A3 out.
    expect(groupCandidates(candidates, neighborFn(0.09), 3)).toEqual([])

    const wide = groupCandidates(candidates, neighborFn(0.1), 3)
    expect(wide).toHaveLength(1)
    expect(wide[0]!.slice().sort()).toEqual(['A0', 'A1', 'A2'])

    // The same graph assembled from the pinned links equals the lookup's graph —
    // so the fast path's untruncated set is exactly the edge set union-find needs.
    const reference = findComponents(
      [
        ['A0', 'A1'],
        ['A1', 'A2']
      ],
      candidates.map(c => c.id)
    ).filter(g => g.length >= 3)
    expect(reference).toEqual([['A0', 'A1', 'A2']])
    expect(wide).toEqual(reference)

    // A truncated (k = 1, the sorted path's shape) lookup sees only the nearest
    // link and no threshold slack, so a caller that ignored the fast path would
    // LOSE the A0-A1-A2 component entirely — the reason auto-cluster must use
    // the full-set fast path (it asks k = N-1 and never truncates).
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

/** Seed the AC9 fixture: the candidate thoughts with drained stored vectors. */
function seedSupersetCandidates(db: Database, angles: number[]): string[] {
  const past = new Date(Date.now() - 10 * 86400000).toISOString()
  const ids = angles.map((_, i) => seedThought({ content: `superset candidate ${i}`, created_at: past }))
  for (let i = 0; i < ids.length; i++) {
    const v = unitAt(angles[i]!)
    db.prepare(`INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)`).run(
      ids[i]!,
      Buffer.from(v.buffer as ArrayBuffer, v.byteOffset, v.byteLength)
    )
  }
  drainPendingEmbeddings(ids)
  return ids
}

/**
 * The AC9 fixture, measured. A tight candidate cluster (`A0` at 0 rad, the rest
 * within 0.06 rad, pairwise cosines >= 0.9982) plus `AC9_DECOYS` non-candidate
 * index rows that all rank CLOSER to `A0` than its nearest candidate.
 */
const CANDIDATE_COUNT = 24
const AC9_DECOYS = 1200
/** Candidates: cos >= 0.9982 with each other, i.e. every pair clears 0.99. */
const AC9_ANGLES: number[] = [0, ...Array.from({ length: CANDIDATE_COUNT - 1 }, (_, i) => 0.001 + i * 0.0025)]
/**
 * Decoys: 1200 ineligible index rows at 0.0002-0.05 rad, so the NEAREST
 * candidate (cos 0.99955) is still further from `A0` than every decoy
 * (cos >= 0.99875). 1200 > the widest pool (`min(1000, topK*10) = 1000` at
 * `topK = 100`), so the pool is filled by decoys ALONE and the old path sees no
 * candidate for `A0` at all — while the candidate-local lookup is unaffected.
 * This is the honest model of the difference: the candidate set is a FILTERED
 * subset of the index (status / age / project / cluster-membership via
 * `listClusterCandidates`), so an index-ranked pool can be crowded out by
 * ineligible neighbours the candidate-local lookup excludes by construction.
 * Below that crowding threshold the two paths agree — `topK` truncates both.
 */
const AC9_DECOYS_BY_ANGLE: Array<{ id: string; angle: number }> = Array.from({ length: AC9_DECOYS }, (_, i) => ({
  id: `DECOY${i}`,
  angle: 0.0002 + i * ((0.05 - 0.0002) / (AC9_DECOYS - 1))
}))
const AC9_UNIVERSE: Array<{ id: string; angle: number }> = [
  ...AC9_ANGLES.map((angle, i) => ({ id: `A${i}`, angle })),
  ...AC9_DECOYS_BY_ANGLE
]

/**
 * The lookup shape the pre-#1566 vec0 path had, stated faithfully: rank the
 * WHOLE index by similarity, keep the top `pool`, then keep the top `topK` of
 * those (`searchThoughts` pool -> `vecSearchIds` `LIMIT topK`) and let the caller
 * intersect with candidates. The pool is a candidate-blind global ranking, so it
 * can only DROP candidates a candidate-local ranking would have kept.
 */
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

/** UUID fixture universe: the same angles, real thought ids. */
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

    const oldPairs = findEmbeddingNeighborPairs(candidates, embeddings, minSimilarity, poolCappedLookup(pool, topK), topK)
    const newPairs = findEmbeddingNeighborPairs(
      candidates,
      embeddings,
      minSimilarity,
      buildInMemoryNeighborLookup(candidates, embeddings),
      topK
    )
    const oldSet = pairSet(oldPairs)
    const newSet = pairSet(newPairs)

    // Precondition: the global pool really is candidate-blind here.
    const poolOfA0 = poolCappedLookup(pool, topK)('A0', embeddings[0]!, topK).map(n => n.id)
    expect(poolOfA0.every(id => id.startsWith('A') || id.startsWith('DECOY'))).toBe(true)

    // The new lookup returns every candidate pair the old one did, plus pairs the
    // old pool never surfaced — a STRICT superset, measured.
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

      // The placement engine is the only live consumer of the candidate-local
      // lookup, so the AC9 superset claim is stated on its edge proposals.
      const result = await proposePlacementPlan({ thoughtId: ids[0]! }, options, { embed: async () => [] })
      const oldResult = await proposePlacementPlan({ thoughtId: ids[0]! }, options, {
        embed: async () => [],
        searchNeighbors: poolCappedLookup(Math.min(1000, topK * 10), topK, uuidUniverse(ids, AC9_ANGLES))
      })

      expect(result.degraded).toBe(false)
      const proposed = new Set(result.edges.map(p => pairKey(p.source_id, p.target_id)))
      const oldProposed = new Set(oldResult.edges.map(p => pairKey(p.source_id, p.target_id)))
      for (const key of oldProposed) expect(proposed.has(key)).toBe(true)
      const onlyNew = [...proposed].filter(k => !oldProposed.has(k))
      expect(onlyNew.length).toBeGreaterThan(0)
      // The old index-ranked pool was crowded out by the decoy rows: it saw
      // none of the source's candidate neighbours, the candidate-local lookup
      // sees them all.
      expect(oldProposed.size).toBe(0)
      expect(proposed.size).toBeGreaterThan(0)
      // Every proposal keeps the documented shape (unconfirmed `related`).
      expect(result.edges.every(p => p.review_required && p.type === 'related')).toBe(true)
    })
  })

  test('auto-cluster is unaffected: it asks for k = N-1, which both shapes answer completely', () => {
    // `defaultSearchNeighbors` asks `k = max(minMembers, candidates.length)`, and
    // the pool (`min(1000, k*10) = 1000`) then contains every one of the N
    // candidates, so both shapes see the full candidate neighbourhood — identical
    // pairs, hence identical groups. (The crowd-out case needs > 1000 ineligible
    // index rows, which is exactly what makes the superset observable there.)
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
    const oldUniverse: Array<{ id: string; angle: number }> = AC9_ANGLES.map((angle, i) => ({ id: `A${i}`, angle }))
    const oldShape = new Set(
      findEmbeddingNeighborPairs(candidates, embeddings, 0.99, poolCappedLookup(Math.min(1000, k * 10), k, oldUniverse), k).map(p =>
        pairKey(p.source_id, p.target_id)
      )
    )
    const newShape = new Set(
      findEmbeddingNeighborPairs(candidates, embeddings, 0.99, buildInMemoryNeighborLookup(candidates, embeddings), k).map(p =>
        pairKey(p.source_id, p.target_id)
      )
    )
    expect(newShape.size).toBeGreaterThan(0)
    expect(oldShape).toEqual(newShape)

    // And the groups built from that shared pair set are identical by definition.
    const neighborFn = (pairs: Set<string>) => (id: string): string[] =>
      [...pairs]
        .filter(key => key.split('::').includes(id))
        .map(key => key.split('::').find(x => x !== id)!)
    expect(groupCandidates(candidates, neighborFn(newShape), 2)).toEqual(groupCandidates(candidates, neighborFn(oldShape), 2))
  })
})
