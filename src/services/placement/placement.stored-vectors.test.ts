import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { closeDb, getDb } from '../../db'
import { searchThoughts } from '../../db/search'
import * as vectorSearchDb from '../../db/search-vector'
import * as embedderClient from '../../embedder/client'
import {
  createTestDb,
  drainPendingEmbeddings,
  seedEdge,
  seedThought,
  withVecDb
} from '../../test/helpers'
import type { SearchNeighborsFn } from '../edge-candidates.service'
import { proposePlacementPlan } from './engine'
import type { PlacementPlan } from './types'

beforeEach(createTestDb)
afterEach(closeDb)

const NOW = '2026-01-01T00:00:00.000Z'

function vec384(angle: number): Float32Array {
  const v = new Float32Array(384)
  v[0] = Math.cos(angle)
  v[1] = Math.sin(angle)
  return v
}

function storeVec(id: string, vector: Float32Array): void {
  getDb()
    .prepare(`INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, 'default')`)
    .run(id, Buffer.from(vector.buffer as ArrayBuffer, vector.byteOffset, vector.byteLength))
  drainPendingEmbeddings([id])
}

function indexLookup(d: Database, projectId: string): SearchNeighborsFn {
  return (_id, embedding, k) =>
    searchThoughts(d, {
      embedding,
      topK: k,
      statusFilter: 'active',
      projectFilter: projectId,
      hybrid: false
    }).map(r => ({ id: r.thought.id, similarity: r.similarity ?? 0 }))
}

function summarize(plan: PlacementPlan) {
  return {
    placement: plan.placement
      ? { kind: plan.placement.kind, target_id: plan.placement.target_id }
      : null,
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

describe('stored-vector pins (task #1571)', () => {
  test('a fully embedded pool costs 0 embedder calls and 0 vec0 queries (default path)', async () => {
    await withVecDb(async () => {
      const a = seedThought({ content: 'alpha' })
      const b = seedThought({ content: 'beta' })
      storeVec(a, vec384(0))
      storeVec(b, vec384(Math.acos(0.9)))

      const embedSpy = spyOn(embedderClient, 'generateEmbeddings')
      const vectorSpy = spyOn(vectorSearchDb, 'vecSearchIds')
      try {
        const plan = await proposePlacementPlan({ thoughtId: a }, { now: NOW, minSimilarity: 0.5 })

        expect(plan.degraded).toBe(false)
        expect(plan.edges.map(e => e.target_id)).toEqual([b])
        expect(embedSpy.mock.calls.length).toBe(0)
        const afterRun = vectorSpy.mock.calls.length

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

      expect(seen).toEqual([['alpha revised']])
      expect(plan.degraded).toBe(false)
      expect(plan.edges.map(e => e.target_id)).toEqual([b])
    })
  })

  test('the default plan equals the index-backed lookup on the existing fixture shape', async () => {
    await withVecDb(async () => {
      const cluster = seedThought({ id: 'eq-c', content: 'eq cluster', is_cluster: 1 })
      const member = seedThought({ id: 'eq-m', content: 'eq member' })
      const root = seedThought({ id: 'eq-root', content: 'eq root' })
      const other = seedThought({ id: 'eq-other', content: 'eq other' })
      const src = seedThought({ id: 'eq-src', content: 'eq source' })
      seedEdge(cluster, member, 'cluster')
      seedEdge(root, member, 'parent')
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
      expect(viaDefault.placement?.kind).toBe('cluster')
      expect(viaDefault.placement?.target_id).toBe(cluster)
      expect(viaDefault.edges.map(e => e.target_id).sort()).toEqual([member, other, root].sort())
      expect(viaDefault.lifecycle.action).toBe('link')
      for (let i = 0; i < viaDefault.edges.length; i++) {
        expect(viaDefault.edges[i]!.confidence).toBeCloseTo(viaIndex.edges[i]!.confidence, 5)
      }
    })
  })

  test('the in-memory lookup is a superset: a nearer non-candidate cannot evict a candidate', async () => {
    await withVecDb(async () => {
      const src = seedThought({ id: 'ss-src', content: 'superset source' })
      storeVec(src, vec384(0))
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
      expect(defaultTargets).toHaveLength(10)
      expect(indexTargets.length).toBeLessThan(defaultTargets.length)
      expect(indexTargets).not.toContain('ss-c9')
      expect(defaultTargets).toContain('ss-c9')
      expect(indexTargets.every(id => defaultTargets.includes(id))).toBe(true)
    })
  })
})
