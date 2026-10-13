/**
 * Stored-vector pins for the placement path (task #1571).
 *
 * The placement engine used to embed the whole candidate pool and then issue one
 * vec0 query per candidate. It now reads the stored `vec_thoughts` vectors
 * (`resolveCandidateEmbeddings`, #1569) and ranks neighbours in memory
 * (`buildInMemoryNeighborLookup`, #1566) — the shape `edge-detect` got in #1567.
 * These tests pin both costs (0 embedder calls, 0 vec0 queries), the
 * injected-dependency seam, freshness (`pending_embeddings` ⇒ live embed) and
 * the equivalence/superset relationship with the index-backed lookup it
 * replaced.
 *
 * The vec0 leg needs a file-backed DB (`withVecDb`, AGENTS.md §8); the
 * `:memory:` suites cannot host `vec_thoughts`.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { closeDb, getDb } from '../../db'
import { searchThoughts } from '../../db/search'
import * as vectorSearchDb from '../../db/search-vector'
import * as embedderClient from '../../embedder/client'
import { createTestDb, drainPendingEmbeddings, seedEdge, seedThought, withVecDb } from '../../test/helpers'
import type { SearchNeighborsFn } from '../edge-candidates.service'
import { proposePlacementPlan } from './engine'
import type { PlacementPlan } from './types'

beforeEach(createTestDb)
afterEach(closeDb)

const NOW = '2026-01-01T00:00:00.000Z'

// ── helpers ─────────────────────────────────────────────────────────────────

/** Unit vector in the (x, y) plane; the angle sets the cosine similarity. */
function vec384(angle: number): Float32Array {
  const v = new Float32Array(384)
  v[0] = Math.cos(angle)
  v[1] = Math.sin(angle)
  return v
}

/**
 * Store a vector by hand and drain the `pending_embeddings` row the v035
 * trigger queued, i.e. model "already embedded with this content" (helpers.ts).
 */
function storeVec(id: string, vector: Float32Array): void {
  getDb()
    .prepare(`INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)`)
    .run(id, Buffer.from(vector.buffer as ArrayBuffer, vector.byteOffset, vector.byteLength))
  drainPendingEmbeddings([id])
}

/**
 * The pre-change default neighbour lookup: one vec0 index query per candidate
 * (`searchThoughts`, active + same project). Reference for the equivalence pin.
 */
function indexLookup(d: Database, projectId: string): SearchNeighborsFn {
  return (_id, embedding, k) =>
    searchThoughts(d, {
      embedding,
      topK: k,
      statusFilter: 'active',
      projectFilter: projectId,
      hybrid: false
    }).map(r => ({ id: r.thought.id, similarity: r.similarity }))
}

/** Structural projection: everything a change of neighbour source could move. */
function summarize(plan: PlacementPlan) {
  return {
    placement: plan.placement ? { kind: plan.placement.kind, target_id: plan.placement.target_id } : null,
    edges: plan.edges.map(e => ({
      source_id: e.source_id,
      target_id: e.target_id,
      type: e.type,
      rule_id: e.rule_id
    })),
    lifecycle: plan.lifecycle.action,
    degraded: plan.degraded
  }
}

// ── cost: no embedder round-trip, no per-candidate vec0 query ────────────────

describe('stored-vector pins (task #1571)', () => {
  test('a fully embedded pool costs 0 embedder calls and 0 vec0 queries (default path)', async () => {
    await withVecDb(async () => {
      const a = seedThought({ content: 'alpha' })
      const b = seedThought({ content: 'beta' })
      storeVec(a, vec384(0))
      storeVec(b, vec384(Math.acos(0.9)))

      // No injected deps: the real defaults (`generateEmbeddings`,
      // `buildInMemoryNeighborLookup`) are the code under test.
      const embedSpy = spyOn(embedderClient, 'generateEmbeddings')
      const vectorSpy = spyOn(vectorSearchDb, 'vecSearchIds')
      try {
        const plan = await proposePlacementPlan({ thoughtId: a }, { now: NOW, minSimilarity: 0.5 })

        // Both stored vectors were reused, so the run produced the pair the
        // threshold admits — a 0 count is not an empty/degraded run.
        expect(plan.degraded).toBe(false)
        expect(plan.edges.map(e => e.target_id)).toEqual([b])
        expect(embedSpy.mock.calls.length).toBe(0)
        const afterRun = vectorSpy.mock.calls.length

        // Positive control: the spy does observe this query path, so 0 calls
        // during the run is evidence rather than a dead spy. The embedder
        // control is the `pending_embeddings` pin below.
        searchThoughts(getDb(), { embedding: vec384(0), topK: 1 })
        expect(vectorSpy.mock.calls.length).toBeGreaterThan(afterRun)
        expect(afterRun).toBe(0)
      } finally {
        embedSpy.mockRestore()
        vectorSpy.mockRestore()
      }
    })
  })

  test('an injected searchNeighbors still wins over the in-memory default', async () => {
    await withVecDb(async () => {
      const a = seedThought({ content: 'alpha' })
      const b = seedThought({ content: 'beta' })
      // Orthogonal vectors: the in-memory lookup reports ~0 similarity, so a
      // proposal can only come from the injected lookup.
      storeVec(a, vec384(0))
      storeVec(b, vec384(Math.PI / 2))

      const plain = await proposePlacementPlan({ thoughtId: a }, { now: NOW, minSimilarity: 0.5 })
      expect(plain.edges).toEqual([])

      let calls = 0
      const injected: SearchNeighborsFn = id => {
        calls++
        return [{ id: id === a ? b : a, similarity: 0.99 }]
      }
      const overridden = await proposePlacementPlan(
        { thoughtId: a },
        { now: NOW, minSimilarity: 0.5 },
        { searchNeighbors: injected }
      )

      expect(calls).toBe(2)
      expect(overridden.edges).toHaveLength(1)
      expect(overridden.edges[0]!.confidence).toBeCloseTo(0.99, 5)
    })
  })

  test('a candidate queued in pending_embeddings is embedded live (freshness)', async () => {
    await withVecDb(async () => {
      const a = seedThought({ content: 'alpha' })
      const b = seedThought({ content: 'beta' })
      // `a`'s stored vector is stale (orthogonal to `b`); its content then
      // changed, which queues it in `pending_embeddings` again.
      storeVec(a, vec384(Math.PI / 2))
      storeVec(b, vec384(Math.acos(0.9)))
      getDb().prepare('UPDATE thoughts SET content = ? WHERE id = ?').run('alpha revised', a)
      const pending = getDb()
        .prepare('SELECT thought_id FROM pending_embeddings WHERE thought_id = ?')
        .get(a)
      expect(pending).not.toBeNull()

      const seen: string[][] = []
      const plan = await proposePlacementPlan(
        { thoughtId: a },
        { now: NOW, minSimilarity: 0.5 },
        {
          embed: async texts => {
            seen.push(texts)
            return texts.map(() => vec384(0))
          }
        }
      )

      // Exactly the pending candidate reaches the embedder, with its CURRENT
      // content; `b` is served from its stored vector.
      expect(seen).toEqual([['alpha revised']])
      expect(plan.degraded).toBe(false)
      // The pair is only reachable through the live vector: the stale one is
      // orthogonal to `b` and below the threshold.
      expect(plan.edges.map(e => e.target_id)).toEqual([b])
    })
  })

  // ── output equivalence / intended superset ─────────────────────────────────

  test('the default plan equals the index-backed lookup on the existing fixture shape', async () => {
    await withVecDb(async () => {
      const cluster = seedThought({ id: 'eq-c', content: 'eq cluster', is_cluster: 1 })
      const member = seedThought({ id: 'eq-m', content: 'eq member' })
      const root = seedThought({ id: 'eq-root', content: 'eq root' })
      const other = seedThought({ id: 'eq-other', content: 'eq other' })
      const src = seedThought({ id: 'eq-src', content: 'eq source' })
      seedEdge(cluster, member, 'cluster')
      seedEdge(root, member, 'parent')
      // Pool = the four non-cluster thoughts; the cluster row is in the vec
      // index but never a candidate (same as before the change).
      storeVec(src, vec384(0))
      storeVec(member, vec384(Math.acos(0.9)))
      storeVec(other, vec384(Math.acos(0.8)))
      storeVec(root, vec384(Math.acos(0.7)))
      storeVec(cluster, vec384(Math.acos(0.6)))

      const options = { now: NOW, minSimilarity: 0.5 }
      const viaDefault = await proposePlacementPlan({ thoughtId: src }, options)
      const viaIndex = await proposePlacementPlan({ thoughtId: src }, options, {
        searchNeighbors: indexLookup(getDb(), 'default')
      })

      expect(summarize(viaDefault)).toEqual(summarize(viaIndex))
      // Same fixture, both branches reached: cluster placement + 3 related edges.
      expect(viaDefault.placement?.kind).toBe('cluster')
      expect(viaDefault.placement?.target_id).toBe(cluster)
      expect(viaDefault.edges.map(e => e.target_id).sort()).toEqual([member, other, root].sort())
      expect(viaDefault.lifecycle.action).toBe('link')
      // Scores come from `1 - distance` (index) vs the exact dot product
      // (in-memory): identical to float32 precision, not bit-identical.
      for (let i = 0; i < viaDefault.edges.length; i++) {
        expect(viaDefault.edges[i]!.confidence).toBeCloseTo(viaIndex.edges[i]!.confidence, 5)
      }
    })
  })

  test('the in-memory lookup is a superset: a nearer non-candidate cannot evict a candidate', async () => {
    await withVecDb(async () => {
      const src = seedThought({ id: 'ss-src', content: 'superset source' })
      storeVec(src, vec384(0))
      // A cluster thought is active and in the vec index but is NOT a pool
      // candidate, so it still consumes one of the index's `LIMIT topK` slots.
      const cluster = seedThought({ id: 'ss-cluster', content: 'superset cluster', is_cluster: 1 })
      storeVec(cluster, vec384(0))
      for (let i = 0; i < 10; i++) {
        const candidate = seedThought({ id: `ss-c${i}`, content: `superset candidate ${i}` })
        storeVec(candidate, vec384(Math.acos(0.95 - 0.03 * i)))
      }

      const options = { now: NOW, minSimilarity: 0.5, topK: 10 }
      const viaDefault = await proposePlacementPlan({ thoughtId: src }, options)
      const viaIndex = await proposePlacementPlan({ thoughtId: src }, options, {
        searchNeighbors: indexLookup(getDb(), 'default')
      })

      const defaultTargets = viaDefault.edges.map(e => e.target_id)
      const indexTargets = viaIndex.edges.map(e => e.target_id)
      // `src` itself and the cluster occupy index slots, so the two farthest
      // candidates fall outside the index window; the in-memory lookup ranks
      // the candidates only and keeps all ten.
      expect(defaultTargets).toHaveLength(10)
      expect(indexTargets.length).toBeLessThan(defaultTargets.length)
      expect(indexTargets).not.toContain('ss-c9')
      expect(defaultTargets).toContain('ss-c9')
      // The difference is one-way: nothing the index kept is dropped.
      expect(indexTargets.every(id => defaultTargets.includes(id))).toBe(true)
    })
  })
})
