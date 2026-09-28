/**
 * Determinism, degradation and input-resolution tests for the placement engine
 * (`engine.ts`, ADR 2026-09-28 / task #950/#951).
 */

import { beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { closeDb, getDb } from '../../db'
import { NotFoundError, ValidationError } from '../../errors'
import { createTestDb, seedThought } from '../../test/helpers'
import { DRAFT_THOUGHT_ID, proposePlacementPlan } from './engine'
import type { PlacementPlan } from './types'

beforeEach(createTestDb)
afterEach(closeDb)

// ── time constants ────────────────────────────────────────────────────────────

const NOW = '2026-01-01T00:00:00.000Z'
const T0  = '2025-01-01T00:00:00.000Z'
const T1  = '2025-02-01T00:00:00.000Z'
const T2  = '2025-03-01T00:00:00.000Z'
const T3  = '2025-04-01T00:00:00.000Z'

// ── helpers ───────────────────────────────────────────────────────────────────

/** Deterministic embed stub: one zero vector per candidate text. */
function okEmbed(record?: number[]): (texts: string[]) => Promise<Float32Array[]> {
  return async texts => {
    record?.push(texts.length)
    return texts.map(() => new Float32Array(384))
  }
}

/** Embed stub that always returns a single vector regardless of input length. */
function mismatchEmbed(record?: number[]): (texts: string[]) => Promise<Float32Array[]> {
  return async texts => {
    record?.push(texts.length)
    return [new Float32Array(384)]
  }
}

function failEmbed(): (texts: string[]) => Promise<Float32Array[]> {
  return async () => { throw new Error('embedder exploded') }
}

/**
 * `searchNeighbors` stub keyed by thought id. Unknown ids get no neighbours.
 */
function stubSearch(map: Record<string, Array<{ id: string; similarity: number }>>) {
  return (_id: string, _emb: Float32Array, _topK: number) => map[_id] ?? []
}

/** Fixture for determinism / ordering tests: four neutral thoughts. */
function seedOrderingFixture() {
  seedThought({ id: 'd-src', content: 'neutral topic alpha', created_at: T0 })
  seedThought({ id: 'd-a', content: 'neutral topic beta',  created_at: T1 })
  seedThought({ id: 'd-b', content: 'neutral topic gamma', created_at: T2 })
  seedThought({ id: 'd-c', content: 'neutral topic delta', created_at: T3 })
  return {
    src: 'd-src',
    search: {
      'd-src': [
        { id: 'd-c', similarity: 0.95 },
        { id: 'd-a', similarity: 0.90 },
        { id: 'd-b', similarity: 0.90 },
      ],
    },
  }
}

// ── determinism & ordering ───────────────────────────────────────────────────

describe('proposePlacementPlan', () => {
  describe('determinism & ordering', () => {
    test('two runs on the same snapshot + injected now yield byte-identical plans', async () => {
      const db = getDb()
      const { src, search } = seedOrderingFixture()
      const deps = { embed: okEmbed(), searchNeighbors: stubSearch(search) }
      const p1 = await proposePlacementPlan({ thoughtId: src }, { now: NOW }, deps, db)
      const p2 = await proposePlacementPlan({ thoughtId: src }, { now: NOW }, deps, db)
      expect(JSON.stringify(p1)).toBe(JSON.stringify(p2))
      expect(p1.generated_at).toBe(NOW)
      expect(p1.degraded).toBe(false)
      expect(p1.thought_id).toBe(src)
    })

    test('edges are stable-sorted: confidence desc then target_id asc (tiebreak)', async () => {
      const db = getDb()
      const { src, search } = seedOrderingFixture()
      const p = await proposePlacementPlan(
        { thoughtId: src },
        { now: NOW },
        { embed: okEmbed(), searchNeighbors: stubSearch(search) },
        db
      )
      expect(p.edges.map(e => e.target_id)).toEqual(['d-c', 'd-a', 'd-b'])
      expect(p.edges.map(e => e.confidence)).toEqual([0.95, 0.9, 0.9])
      expect(p.edges.every(e => e.type === 'related')).toBe(true)
      // d-a and d-b tie on confidence → alphabetical (a < b) wins.
      expect(p.edges.findIndex(e => e.target_id === 'd-a')!).toBeLessThan(
        p.edges.findIndex(e => e.target_id === 'd-b')
      )
    })

    test('options.maxProposals caps the emitted edges', async () => {
      const db = getDb()
      seedThought({ id: 'cap-s', content: 'topic alpha', created_at: T0 })
      seedThought({ id: 'cap-a', content: 'topic beta',  created_at: T0 })
      seedThought({ id: 'cap-b', content: 'topic gamma', created_at: T0 })
      seedThought({ id: 'cap-c', content: 'topic delta', created_at: T0 })
      const p = await proposePlacementPlan(
        { thoughtId: 'cap-s' },
        { now: NOW, maxProposals: 2 },
        { embed: okEmbed(), searchNeighbors: stubSearch({ 'cap-s': [{ id: 'cap-a', similarity: 0.95 }, { id: 'cap-b', similarity: 0.9 }, { id: 'cap-c', similarity: 0.85 }] }) },
        db
      )
      expect(p.edges).toHaveLength(2)
      expect(p.edges.map(e => e.target_id)).toEqual(['cap-a', 'cap-b'])
      expect(p.edges.map(e => e.confidence)).toEqual([0.95, 0.9])
    })
  })

  // ── degraded path ────────────────────────────────────────────────────────

  describe('degraded path: embedder failure or mismatch', () => {
    test('throwing embedder sets degraded:true, keeps plan, never throws', async () => {
      const db = getDb()
      const src = seedThought({ id: 'dg-src', content: 'standalone thing', created_at: T0 })
      // Wrap in try/catch: the engine must resolve (not reject) even on embedder failure.
      let caught = false
      let p: PlacementPlan | undefined
      try {
        p = await proposePlacementPlan(
          { thoughtId: src },
          { now: NOW },
          { embed: failEmbed(), searchNeighbors: stubSearch({}) },
          db
        )
      } catch {
        caught = true
      }
      expect(caught).toBe(false)
      // TS cannot narrow the assignment inside the try block, but we asserted
      // caught is false so the plan is guaranteed present.
      expect(p!.degraded).toBe(true)
      expect(p!.edges).toEqual([])
      expect(p!.placement).toBeNull()
      expect(p!.lifecycle.action).toBe('keep')
      expect(p!.lifecycle.rationale).toContain('embedder unavailable')
    })

    test('degraded: lexical merge still fires when embedder throws', async () => {
      const db = getDb()
      const src = seedThought({ id: 'dm-src', content: 'the quick brown fox', created_at: T0 })
      // Merge target seeded but never referenced directly — findMergeTarget discovers
      // it purely by lexical content against all active pool members.
      seedThought({ id: 'dm-tgt', content: 'the quick brown fox jumped', created_at: T1 })
      const p = await proposePlacementPlan(
        { thoughtId: src },
        { now: NOW },
        { embed: failEmbed() },
        db
      )
      expect(p.degraded).toBe(true)
      expect(p.edges).toEqual([]) // no embedding-based pairs emitted
      expect(p.lifecycle.action).toBe('merge')
      expect(p.lifecycle.confidence).toBeCloseTo(0.8)
    })

    test('embedder returns a mismatched vector count ⇒ degraded, no throw', async () => {
      const db = getDb()
      const src = seedThought({ id: 'mm-src', content: 'mismatch source', created_at: T0 })
      seedThought({ id: 'mm-o', content: 'mismatch other', created_at: T1 })
      const lengths: number[] = []
      const p = await proposePlacementPlan(
        { thoughtId: src },
        { now: NOW },
        { embed: mismatchEmbed(lengths), searchNeighbors: stubSearch({}) },
        db
      )
      expect(lengths).toEqual([2]) // engine embedded the full pool of 2 candidates
      expect(p.degraded).toBe(true)
      expect(p.edges).toEqual([])
    })
  })

  // ── input resolution & edge cases ────────────────────────────────────────

  describe('input resolution & edge cases', () => {
    test('draft content: thought_id is the sentinel; edge source_id carries the sentinel', async () => {
      const db = getDb()
      const tgt = seedThought({ id: 'dr-tgt', content: 'the quick brown fox jumped', created_at: T1 })
      const p = await proposePlacementPlan(
        { content: 'the quick brown fox', projectId: 'default' },
        { now: NOW },
        { embed: okEmbed(), searchNeighbors: stubSearch({ [DRAFT_THOUGHT_ID]: [{ id: tgt, similarity: 0.9 }] }) },
        db
      )
      expect(p.thought_id).toBe(DRAFT_THOUGHT_ID)
      expect(p.degraded).toBe(false)
      expect(p.edges).toHaveLength(1)
      expect(p.edges[0].source_id).toBe(DRAFT_THOUGHT_ID)
      expect(p.edges[0].target_id).toBe(tgt)
      // Lexical near-dup (overlap 0.8) triggers merge, which beats the related edge.
      expect(p.lifecycle.action).toBe('merge')
    })

    test('unknown thoughtId rejects NotFoundError', async () => {
      await expect(proposePlacementPlan({ thoughtId: 'nonexistent-uuid-here' }, { now: NOW }, {}, getDb()))
        .rejects.toBeInstanceOf(NotFoundError)
    })

    test('neither thoughtId nor content rejects ValidationError', async () => {
      await expect(proposePlacementPlan({}, { now: NOW }, {}, getDb()))
        .rejects.toBeInstanceOf(ValidationError)
    })

    test('cluster source short-circuits to keep without embedding', async () => {
      const db = getDb()
      const src = seedThought({ id: 'cs-src', content: 'source cluster', is_cluster: 1, created_at: T0 })
      let embedCalls = 0
      const p = await proposePlacementPlan(
        { thoughtId: src },
        { now: NOW },
        {
          embed: async () => { embedCalls += 1; return [] },
          searchNeighbors: stubSearch({})
        },
        db
      )
      expect(p.thought_id).toBe('cs-src')
      expect(p.lifecycle.action).toBe('keep')
      expect(p.lifecycle.rationale).toBe('source is a cluster thought; nothing to place or link')
      expect(embedCalls).toBe(0)
      expect(p.edges).toEqual([])
      expect(p.placement).toBeNull()
    })
  })
})
