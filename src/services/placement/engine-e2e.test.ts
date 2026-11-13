import { beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { closeDb, getDb } from '../../db'
import { createTestDb, seedEdge, seedThought } from '../../test/helpers'
import { proposePlacementPlan } from './engine'

beforeEach(createTestDb)
afterEach(closeDb)

const NOW = '2026-01-01T00:00:00.000Z'
const T0 = '2025-01-01T00:00:00.000Z'
const T1 = '2025-02-01T00:00:00.000Z'
const T2 = '2025-03-01T00:00:00.000Z'

function okEmbed(record?: number[]): (texts: string[]) => Promise<Float32Array[]> {
  return async texts => {
    record?.push(texts.length)
    return texts.map(() => new Float32Array(384))
  }
}

function stubSearch(map: Record<string, Array<{ id: string; similarity: number }>>) {
  return (_id: string, _emb: Float32Array, _topK: number) => map[_id] ?? []
}

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
        {
          embed: okEmbed(),
          searchNeighbors: stubSearch({ [src]: [{ id: tgt, similarity: 0.9 }] })
        },
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
      const tgt = seedThought({
        id: 'mg-tgt',
        content: 'the quick brown fox jumped',
        created_at: T1
      })
      const p = await proposePlacementPlan(
        { thoughtId: src },
        { now: NOW },
        {
          embed: okEmbed(),
          searchNeighbors: stubSearch({ [src]: [{ id: tgt, similarity: 0.5 }] })
        },
        db
      )
      expect(p.degraded).toBe(false)
      expect(p.edges).toEqual([])
      expect(p.placement).toBeNull()
      expect(p.lifecycle.action).toBe('merge')
      expect(p.lifecycle.confidence).toBeCloseTo(0.8)
      expect(p.lifecycle.blocked_by).toEqual([])
      expect(p.lifecycle.rationale).toContain('near-duplicate')
    })

    test('replaces+archive: newer evolving near-dup of an active target', async () => {
      const db = getDb()
      const old_ = seedThought({
        id: 'ra-old',
        content: 'postgres for storage persists data',
        created_at: T0
      })
      const new_ = seedThought({
        id: 'ra-new',
        content: 'postgres now for storage persists data',
        created_at: T1
      })
      const p = await proposePlacementPlan(
        { thoughtId: new_ },
        { now: NOW },
        {
          embed: okEmbed(),
          searchNeighbors: stubSearch({ [new_]: [{ id: old_, similarity: 0.9 }] })
        },
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
      expect(p.lifecycle.action).not.toBe('merge')
    })

    test('cluster placement: majority of clustered neighbours in one cluster', async () => {
      const db = getDb()
      const clusterId = seedThought({
        id: 'cl-pl',
        content: 'aggregate cluster',
        is_cluster: 1,
        created_at: T0
      })
      const member = seedThought({
        id: 'cl-m',
        content: 'member one of the cluster',
        created_at: T1
      })
      const src = seedThought({ id: 'cl-src', content: 'another member idea', created_at: T2 })
      seedEdge(clusterId, member, 'cluster')
      const p = await proposePlacementPlan(
        { thoughtId: src },
        { now: NOW },
        {
          embed: okEmbed(),
          searchNeighbors: stubSearch({ [src]: [{ id: member, similarity: 0.9 }] })
        },
        db
      )
      expect(p.placement).not.toBeNull()
      expect(p.placement!.kind).toBe('cluster')
      expect(p.placement!.target_id).toBe(clusterId)
      expect(p.degraded).toBe(false)
    })
  })

  describe('lifecycle precedence (replaces+archive > merge > link > keep)', () => {
    test('merge takes precedence over link when a near-dup and a related edge coexist', async () => {
      const db = getDb()
      const src = seedThought({ id: 'ml-src', content: 'the quick brown fox', created_at: T0 })
      const tgt = seedThought({
        id: 'ml-tgt',
        content: 'the quick brown fox jumped',
        created_at: T1
      })
      const p = await proposePlacementPlan(
        { thoughtId: src },
        { now: NOW },
        {
          embed: okEmbed(),
          searchNeighbors: stubSearch({ [src]: [{ id: tgt, similarity: 0.95 }] })
        },
        db
      )
      expect(p.edges).toHaveLength(1)
      expect(p.edges[0].type).toBe('related')
      expect(p.lifecycle.action).toBe('merge')
      expect(p.lifecycle.rationale).toContain('near-duplicate')
    })
  })

  describe('blocked_by for non-confirmable moves', () => {
    test('merge blocks when source is archived', async () => {
      const db = getDb()
      const src = seedThought({
        id: 'mb-src',
        content: 'alpha beta gamma delta',
        created_at: T0,
        status: 'archived'
      })
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

    test('replaces+archive does not block when the newer source is archived (the older target is the archive candidate)', async () => {
      const db = getDb()
      const old_ = seedThought({ id: 'raa-old', content: 'x y z', created_at: T0 })
      const new_ = seedThought({
        id: 'raa-new',
        content: 'x y z updated w',
        created_at: T1,
        status: 'archived'
      })
      const p = await proposePlacementPlan(
        { thoughtId: new_ },
        { now: NOW },
        {
          embed: okEmbed(),
          searchNeighbors: stubSearch({ [new_]: [{ id: old_, similarity: 0.9 }] })
        },
        db
      )
      expect(p.lifecycle.action).toBe('replaces+archive')
      expect(p.lifecycle.blocked_by).toEqual([])
    })
  })

  describe('regression: lifecycle under maxProposals cap (#952, fix #955)', () => {
    test('replaces+archive is preserved when the supersede edge sorts past the cap', async () => {
      const db = getDb()
      seedThought({
        id: 'rc-src',
        content: 'now postgres for storage persists data',
        created_at: T1
      })
      seedThought({ id: 'rc-old', content: 'postgres for storage persists data', created_at: T0 })
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
              { id: 'rc-old', similarity: 0.8 }
            ]
          })
        },
        db
      )

      expect(p.edges).toHaveLength(2)
      expect(p.edges.map(e => e.target_id)).toEqual(['rc-a', 'rc-b'])
      expect(p.edges.every(e => e.rule_id !== 'supersede.newer_replaces_older')).toBe(true)
      expect(p.lifecycle.action).toBe('replaces+archive')
      expect(p.lifecycle.blocked_by).toEqual([])
      expect(p.lifecycle.action).not.toBe('link')
    })
  })
})
