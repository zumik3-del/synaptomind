/**
 * Core behavioral tests for the deterministic propose-only placement engine
 * (`engine.ts`, ADR 2026-09-28 / task #950/#951).
 *
 * Per the ADR 2026-09-28 handoff:
 *  - All tests run on a fresh `:memory:` DB (`createTestDb`) with stubbed
 *    `embed` / `searchNeighbors` deps, so the vec0 extension is **not** required
 *    and no real huggingface process is spawned. This mirrors the convention in
 *    `placement.test.ts` (task #947). A real-vec0 / `withVecDb` integration
 *    test is deliberately deferred because the contract is already covered by
 *    the stubbed path; the vector leg is exercised implicitly by the embedder
 *    and search unit suites.
 *  - `proposePlacementPlan(input, options, deps, d)` assembles a read-only
 *    {@link PlacementPlan}. Lifecycle precedence: replaces+archive > merge >
 *    link > keep. Degraded on embedder failure (never throws). Existing-edge
 *    pairs excluded. Edges stable-sorted (confidence desc, target_id asc).
 *    Merge target tiebreak: overlap desc then id asc.
 */

import { beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { closeDb, getDb } from '../../db'
import { createTestDb, seedEdge, seedThought } from '../../test/helpers'
import { proposePlacementPlan } from './engine'

beforeEach(createTestDb)
afterEach(closeDb)

// ── time constants ────────────────────────────────────────────────────────────

const NOW = '2026-01-01T00:00:00.000Z'
const T0  = '2025-01-01T00:00:00.000Z'
const T1  = '2025-02-01T00:00:00.000Z'
const T2  = '2025-03-01T00:00:00.000Z'

// ── helpers ───────────────────────────────────────────────────────────────────

/** Deterministic embed stub: one zero vector per candidate text. */
function okEmbed(record?: number[]): (texts: string[]) => Promise<Float32Array[]> {
  return async texts => {
    record?.push(texts.length)
    return texts.map(() => new Float32Array(384))
  }
}

/**
 * `searchNeighbors` stub keyed by thought id. Unknown ids get no neighbours.
 * Seeded neighbours must exist in the pool (active, same-project, non-cluster)
 * or they are dropped by `findEmbeddingNeighborPairs`.
 */
function stubSearch(map: Record<string, Array<{ id: string; similarity: number }>>) {
  return (_id: string, _emb: Float32Array, _topK: number) => map[_id] ?? []
}

// ── end-to-end branches ───────────────────────────────────────────────────────

describe('proposePlacementPlan', () => {
  describe('end-to-end branches on createTestDb()', () => {
    test('keep: isolated thought, no neighbours', async () => {
      const db = getDb()
      const src = seedThought({ id: 'k-src', content: 'standalone idea', created_at: T0 })
      const p = await proposePlacementPlan(
        { thoughtId: src },
        { now: NOW },
        { embed: okEmbed(), searchNeighbors: stubSearch({}) },
        db
      )
      expect(p.thought_id).toBe(src)
      expect(p.degraded).toBe(false)
      expect(p.edges).toEqual([])
      expect(p.placement).toBeNull()
      expect(p.lifecycle.action).toBe('keep')
      expect(p.generated_at).toBe(NOW)
    })

    test('link: one high-similarity related neighbour, no typed cues', async () => {
      const db = getDb()
      const src = seedThought({ id: 'lk-src', content: 'plain topic one', created_at: T0 })
      const tgt = seedThought({ id: 'lk-tgt', content: 'plain topic two', created_at: T1 })
      const p = await proposePlacementPlan(
        { thoughtId: src },
        { now: NOW },
        { embed: okEmbed(), searchNeighbors: stubSearch({ [src]: [{ id: tgt, similarity: 0.9 }] }) },
        db
      )
      expect(p.lifecycle.action).toBe('link')
      expect(p.edges).toHaveLength(1)
      expect(p.edges[0].type).toBe('related')
      expect(p.edges[0].rule_id).toBe('fallback.embedding_related')
      expect(p.edges[0].confidence).toBe(0.9)
      expect(p.edges[0].source_id).toBe(src)
      expect(p.edges[0].target_id).toBe(tgt)
      expect(p.lifecycle.blocked_by).toEqual([])
    })

    test('merge: lexical near-dup of an active thought, embedding below threshold', async () => {
      const db = getDb()
      const src = seedThought({ id: 'mg-src', content: 'the quick brown fox', created_at: T0 })
      const tgt = seedThought({ id: 'mg-tgt', content: 'the quick brown fox jumped', created_at: T1 })
      const p = await proposePlacementPlan(
        { thoughtId: src },
        { now: NOW },
        { embed: okEmbed(), searchNeighbors: stubSearch({ [src]: [{ id: tgt, similarity: 0.5 }] }) },
        db
      )
      expect(p.degraded).toBe(false)
      expect(p.edges).toEqual([])
      expect(p.placement).toBeNull()
      expect(p.lifecycle.action).toBe('merge')
      expect(p.lifecycle.confidence).toBeCloseTo(0.8)   // jaccard(4/5)
      expect(p.lifecycle.blocked_by).toEqual([])
      expect(p.lifecycle.rationale).toContain('near-duplicate')
    })

    test('replaces+archive: newer evolving near-dup of an active target', async () => {
      const db = getDb()
      const old_ = seedThought({ id: 'ra-old', content: 'postgres for storage persists data', created_at: T0 })
      const new_ = seedThought({ id: 'ra-new', content: 'postgres now for storage persists data', created_at: T1 })
      const p = await proposePlacementPlan(
        { thoughtId: new_ },
        { now: NOW },
        { embed: okEmbed(), searchNeighbors: stubSearch({ [new_]: [{ id: old_, similarity: 0.9 }] }) },
        db
      )
      expect(p.lifecycle.action).toBe('replaces+archive')
      expect(p.lifecycle.blocked_by).toEqual([])
      expect(p.edges).toHaveLength(1)
      expect(p.edges[0].type).toBe('replaces')
      expect(p.edges[0].rule_id).toBe('supersede.newer_replaces_older')
      expect(p.edges[0].signals.temporalOrder).toBe('newer')
      expect(p.edges[0].signals.targetStatus).toBe('active')
      expect(p.edges[0].signals.lexicalOverlap).toBeCloseTo(5 / 6, 2)
      expect(p.lifecycle.rationale).toContain('archive the older target')
      // The lexical overlap (5/6 ≈ 0.83) also qualifies a merge target, but
      // replaces+archive takes precedence over merge (lifecycle ordering).
      expect(p.lifecycle.action).not.toBe('merge')
    })

    test('cluster placement: majority of clustered neighbours in one cluster', async () => {
      const db = getDb()
      const clusterId = seedThought({ id: 'cl-pl', content: 'aggregate cluster', is_cluster: 1, created_at: T0 })
      const member = seedThought({ id: 'cl-m', content: 'member one of the cluster', created_at: T1 })
      const src = seedThought({ id: 'cl-src', content: 'another member idea', created_at: T2 })
      seedEdge(clusterId, member, 'cluster')
      const p = await proposePlacementPlan(
        { thoughtId: src },
        { now: NOW },
        { embed: okEmbed(), searchNeighbors: stubSearch({ [src]: [{ id: member, similarity: 0.9 }] }) },
        db
      )
      expect(p.placement).not.toBeNull()
      expect(p.placement!.kind).toBe('cluster')
      expect(p.placement!.target_id).toBe(clusterId)
      expect(p.degraded).toBe(false)
    })
  })

  // ── lifecycle precedence ─────────────────────────────────────────────────

  describe('lifecycle precedence (replaces+archive > merge > link > keep)', () => {
    test('merge takes precedence over link when a near-dup and a related edge coexist', async () => {
      const db = getDb()
      const src = seedThought({ id: 'ml-src', content: 'the quick brown fox', created_at: T0 })
      const tgt = seedThought({ id: 'ml-tgt', content: 'the quick brown fox jumped', created_at: T1 })
      const p = await proposePlacementPlan(
        { thoughtId: src },
        { now: NOW },
        { embed: okEmbed(), searchNeighbors: stubSearch({ [src]: [{ id: tgt, similarity: 0.95 }] }) },
        db
      )
      // Related edge exists (sim 0.95 ≥ minSimilarity), but merge fires first.
      expect(p.edges).toHaveLength(1)
      expect(p.edges[0].type).toBe('related')
      expect(p.lifecycle.action).toBe('merge')
      expect(p.lifecycle.rationale).toContain('near-duplicate')
    })
  })

  // ── blocked_by ───────────────────────────────────────────────────────────

  describe('blocked_by for non-confirmable moves', () => {
    test('merge blocks when source is archived', async () => {
      const db = getDb()
      const src = seedThought({ id: 'mb-src', content: 'alpha beta gamma delta', created_at: T0, status: 'archived' })
      // Merge target seeded by content only; its id is not needed by the test.
      seedThought({ id: 'mb-tgt', content: 'alpha beta gamma delta epsilon', created_at: T1 })
      const p = await proposePlacementPlan(
        { thoughtId: src },
        { now: NOW },
        { embed: okEmbed(), searchNeighbors: stubSearch({}) },
        db
      )
      expect(p.lifecycle.action).toBe('merge')
      expect(p.lifecycle.blocked_by).toEqual(['source is archived'])
    })

    test('merge blocks when source is a profile thought', async () => {
      const db = getDb()
      const src = seedThought({ id: 'mf-src', content: 'red green blue yellow', created_at: T0, is_profile: 1 })
      seedThought({ id: 'mf-tgt', content: 'red green blue yellow orange', created_at: T1 })
      const p = await proposePlacementPlan(
        { thoughtId: src },
        { now: NOW },
        { embed: okEmbed(), searchNeighbors: stubSearch({}) },
        db
      )
      expect(p.lifecycle.action).toBe('merge')
      expect(p.lifecycle.blocked_by).toEqual(['source is profile'])
    })

    test('replaces+archive does not block when the newer source is archived (the older target is the archive candidate)', async () => {
      const db = getDb()
      const old_ = seedThought({ id: 'raa-old', content: 'x y z', created_at: T0 })
      const new_ = seedThought({ id: 'raa-new', content: 'x y z updated w', created_at: T1, status: 'archived' })
      const p = await proposePlacementPlan(
        { thoughtId: new_ },
        { now: NOW },
        { embed: okEmbed(), searchNeighbors: stubSearch({ [new_]: [{ id: old_, similarity: 0.9 }] }) },
        db
      )
      // Option (b): the newer source survives, so its own status is not a
      // blocker; the archive candidate is the active older target.
      expect(p.lifecycle.action).toBe('replaces+archive')
      expect(p.lifecycle.blocked_by).toEqual([])
    })
  })

  // ── regression: lifecycle under maxProposals cap (#952, verified #955) ───

  describe('regression: lifecycle under maxProposals cap (#952, fix #955)', () => {
    test('replaces+archive is preserved when the supersede edge sorts past the cap', async () => {
      const db = getDb()
      // Source is newer (T1) with an evolution cue ("now") and high Jaccard
      // overlap (5/6 ≈ 0.83) with the old target → supersede rule fires.
      // Embedding sim for the supersede pair is 0.80, giving confidence
      // ≈ (0.83 + 0.80) / 2 ≈ 0.82.
      seedThought({ id: 'rc-src', content: 'now postgres for storage persists data', created_at: T1 })
      seedThought({ id: 'rc-old', content: 'postgres for storage persists data', created_at: T0 })
      // Three related neighbours with neutral content (no typed cues) and
      // embedding similarities that rank above the supersede edge.
      seedThought({ id: 'rc-a', content: 'unrelated topic alpha', created_at: T0 })
      seedThought({ id: 'rc-b', content: 'unrelated topic beta', created_at: T0 })
      seedThought({ id: 'rc-c', content: 'unrelated topic gamma', created_at: T0 })

      const p = await proposePlacementPlan(
        { thoughtId: 'rc-src' },
        { now: NOW, maxProposals: 2 },
        {
          embed: okEmbed(),
          searchNeighbors: stubSearch({
            'rc-src': [
              { id: 'rc-a', similarity: 0.99 },
              { id: 'rc-b', similarity: 0.97 },
              { id: 'rc-c', similarity: 0.96 },
              { id: 'rc-old', similarity: 0.80 },
            ],
          }),
        },
        db
      )

      // Only the two highest-confidence related edges survive the cap.
      expect(p.edges).toHaveLength(2)
      expect(p.edges.map(e => e.target_id)).toEqual(['rc-a', 'rc-b'])
      // The supersede edge (conf ≈ 0.82) sorted past the cap and is absent
      // from the emitted list.
      expect(p.edges.every(e => e.rule_id !== 'supersede.newer_replaces_older')).toBe(true)
      // But the lifecycle still correctly reflects replaces+archive because
      // the replace-edge probe runs on the uncapped list (fix #955).
      expect(p.lifecycle.action).toBe('replaces+archive')
      expect(p.lifecycle.blocked_by).toEqual([])
      // Without the #955 fix the lifecycle would have been 'link' (derived
      // from the capped edges) — assert it is NOT.
      expect(p.lifecycle.action).not.toBe('link')
    })
  })
})
