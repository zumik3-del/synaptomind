import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { closeDb, getDb } from '../../db'
import * as searchDb from '../../db/search'
import {
  createTestDb,
  drainPendingEmbeddings,
  seedEdge,
  seedThought,
  withVecDb
} from '../../test/helpers'
import type { SearchNeighborsFn } from '../edge-candidates.service'
import { proposePlacementPlan } from './engine'

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

function keyedEmbed(table: Record<string, Float32Array>, fallback = vec384(0)) {
  return async (texts: string[]): Promise<Float32Array[]> => texts.map(t => table[t] ?? fallback)
}

function indexLookup(projectId: string): SearchNeighborsFn {
  return (_id, embedding, k) =>
    searchDb
      .searchThoughts(getDb(), {
        embedding,
        topK: k,
        statusFilter: 'active',
        projectFilter: projectId,
        hybrid: false
      })
      .map(r => ({ id: r.thought.id, similarity: r.similarity ?? 0 }))
}

describe('#1574 pin probes', () => {
  test('P1 claim: a fully-stored pool makes 0 embedder calls (counting deps.embed)', async () => {
    await withVecDb(async () => {
      const a = seedThought({ content: 'alpha' })
      const b = seedThought({ content: 'beta' })
      storeVec(a, vec384(0))
      storeVec(b, vec384(Math.acos(0.9)))

      const calls: string[][] = []
      const plan = await proposePlacementPlan(
        { thoughtId: a },
        { now: NOW, minSimilarity: 0.5 },
        {
          embed: async texts => {
            calls.push(texts)
            return texts.map(() => vec384(0))
          }
        }
      )
      expect(plan.degraded).toBe(false)
      expect(plan.edges.map(e => e.target_id)).toEqual([b])
      expect(calls).toEqual([])
    })
  })

  test('P1b claim: the default neighbour path issues 0 vec0 queries of its own', async () => {
    await withVecDb(async () => {
      const a = seedThought({ content: 'alpha' })
      const b = seedThought({ content: 'beta' })
      storeVec(a, vec384(0))
      storeVec(b, vec384(Math.acos(0.9)))

      // Count the INDEX itself: the pre-change default called `searchThoughts`
      // once per candidate; the in-memory default never calls it. Do NOT inject
      // `searchNeighbors` here — it is consulted once per candidate on BOTH
      // revisions, so counting it measures nothing about this change.
      const searchSpy = spyOn(searchDb, 'searchThoughts')
      try {
        const plan = await proposePlacementPlan(
          { thoughtId: a },
          { now: NOW, minSimilarity: 0.5 },
          { embed: async texts => texts.map(() => vec384(0)) }
        )
        expect(plan.degraded).toBe(false)
        expect(plan.edges.map(e => e.target_id)).toEqual([b])
        expect(searchSpy.mock.calls.length).toBe(0)
      } finally {
        searchSpy.mockRestore()
      }
    })
  })

  test('P2 claim: an injected searchNeighbors is consulted with the pair it reports', async () => {
    await withVecDb(async () => {
      const a = seedThought({ content: 'alpha' })
      const b = seedThought({ content: 'beta' })
      storeVec(a, vec384(0))
      storeVec(b, vec384(Math.PI / 2))

      let calls = 0
      const injected: SearchNeighborsFn = id => {
        calls++
        return [{ id: id === a ? b : a, similarity: 0.99 }]
      }
      const plan = await proposePlacementPlan(
        { thoughtId: a },
        { now: NOW, minSimilarity: 0.5 },
        { embed: keyedEmbed({}), searchNeighbors: injected }
      )
      expect(calls).toBe(2)
      expect(plan.edges).toHaveLength(1)
      expect(plan.edges[0]!.target_id).toBe(b)
      expect(plan.edges[0]!.confidence).toBeCloseTo(0.99, 5)
    })
  })

  test('P3 claim: only the pending candidate is embedded live', async () => {
    await withVecDb(async () => {
      const a = seedThought({ content: 'alpha' })
      const b = seedThought({ content: 'beta' })
      storeVec(a, vec384(Math.PI / 2))
      storeVec(b, vec384(Math.acos(0.9)))
      getDb().prepare('UPDATE thoughts SET content = ? WHERE id = ?').run('alpha revised', a)

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

  test('P4 claim: the default plan equals the index-backed lookup on the eq fixture', async () => {
    await withVecDb(async () => {
      const cluster = seedThought({ id: 'eq-c', content: 'eq cluster', is_cluster: 1 })
      const member = seedThought({ id: 'eq-m', content: 'eq member' })
      const root = seedThought({ id: 'eq-root', content: 'eq root' })
      const other = seedThought({ id: 'eq-other', content: 'eq other' })
      const src = seedThought({ id: 'eq-src', content: 'eq source' })
      seedEdge(cluster, member, 'cluster')
      seedEdge(root, member, 'parent')
      const fixture: Record<string, Float32Array> = {
        'eq source': vec384(0),
        'eq member': vec384(Math.acos(0.9)),
        'eq other': vec384(Math.acos(0.8)),
        'eq root': vec384(Math.acos(0.7)),
        'eq cluster': vec384(Math.acos(0.6))
      }
      storeVec(src, fixture['eq source']!)
      storeVec(member, fixture['eq member']!)
      storeVec(other, fixture['eq other']!)
      storeVec(root, fixture['eq root']!)
      storeVec(cluster, fixture['eq cluster']!)

      const options = { now: NOW, minSimilarity: 0.5 }
      const embed = keyedEmbed(fixture)
      const viaDefault = await proposePlacementPlan({ thoughtId: src }, options, { embed })
      const viaIndex = await proposePlacementPlan({ thoughtId: src }, options, {
        embed,
        searchNeighbors: indexLookup('default')
      })

      const project = (p: typeof viaDefault) => ({
        kind: p.placement?.kind,
        target: p.placement?.target_id,
        edges: p.edges.map(e => `${e.target_id}@${e.confidence.toFixed(6)}`).sort(),
        lifecycle: p.lifecycle.action
      })
      const expected: ReturnType<typeof project> = {
        kind: 'cluster',
        target: cluster,
        edges: [`${member}@0.900000`, `${other}@0.800000`, `${root}@0.700000`].sort(),
        lifecycle: 'link'
      }
      expect(project(viaDefault)).toEqual(expected)
      expect(project(viaIndex)).toEqual(expected)
    })
  })

  test('P5 claim: the default lookup keeps topK slots the index spent on non-candidates', async () => {
    await withVecDb(async () => {
      const src = seedThought({ id: 'ss-src', content: 'superset source' })
      const cluster = seedThought({ id: 'ss-cluster', content: 'superset cluster', is_cluster: 1 })
      const candidates: Record<string, Float32Array> = {}
      for (let i = 0; i < 10; i++) {
        const content = `superset candidate ${i}`
        candidates[content] = vec384(Math.acos(0.95 - 0.03 * i))
      }
      storeVec(src, vec384(0))
      storeVec(cluster, vec384(0))
      for (const [content, vector] of Object.entries(candidates)) {
        storeVec(seedThought({ content }), vector)
      }

      const options = { now: NOW, minSimilarity: 0.5, topK: 10 }
      const embed = keyedEmbed({
        ...candidates,
        'superset source': vec384(0),
        'superset cluster': vec384(0)
      })
      const viaDefault = await proposePlacementPlan({ thoughtId: src }, options, { embed })
      const viaIndex = await proposePlacementPlan({ thoughtId: src }, options, {
        embed,
        searchNeighbors: indexLookup('default')
      })

      const defaultTargets = viaDefault.edges.map(e => e.target_id)
      const indexTargets = viaIndex.edges.map(e => e.target_id)
      expect(defaultTargets).toHaveLength(10)
      expect(indexTargets).toHaveLength(8)
      expect(defaultTargets).not.toContain('ss-cluster')
      expect(indexTargets).not.toContain('ss-cluster')
      const defaultIds = new Set(defaultTargets)
      expect(indexTargets.every(id => defaultIds.has(id))).toBe(true)
    })
  })
})
