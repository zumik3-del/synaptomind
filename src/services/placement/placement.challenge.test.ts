import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { closeDb, getDb } from '../../db'
import { searchThoughts } from '../../db/search'
import * as vectorSearchDb from '../../db/search-vector'
import { getThoughtRow } from '../../db/thoughts'
import * as embedderClient from '../../embedder/client'
import { stopEmbedderProcess } from '../../embedder/client-core'
import {
  createTestDb,
  drainPendingEmbeddings,
  seedEdge,
  seedThought,
  withVecDb
} from '../../test/helpers'
import { proposePlacementPlan } from './engine'
import { proposePlacement } from './placement'

/*
 * Reply contract of `src/embedder/__fixtures__/stub-embedder.ts`: 3-dim vectors
 * `[text.length, 1, 2]`. The dimensions deliberately mismatch the 384-dim stored
 * vectors, so `cosineSimilarity` reports UNSCORABLE (0) for a stub vector against
 * a stored one — a stub-served candidate can be counted as an embedder call but
 * cannot fake a pair.
 */
const STUB_EMBEDDER = `${import.meta.dir}/../../embedder/__fixtures__/stub-embedder.ts`

beforeEach(createTestDb)
afterEach(async () => {
  await stopEmbedderProcess()
  delete process.env.SYNAPTOMIND_EMBEDDER_SCRIPT
  closeDb()
})

const NOW = '2026-01-01T00:00:00.000Z'
const DEGRADED_REASONS = [
  'embedder unavailable',
  'embedder returned a mismatched number of vectors'
]

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

function dropVec(id: string): void {
  getDb().prepare('DELETE FROM vec_thoughts WHERE id = ?').run(id)
}

function rowCounts(): Record<string, number> {
  const d = getDb()
  const count = (sql: string) => (d.prepare(sql).get() as { n: number }).n
  return {
    edges: count('SELECT COUNT(*) AS n FROM edges'),
    thoughts: count('SELECT COUNT(*) AS n FROM thoughts'),
    pending: count('SELECT COUNT(*) AS n FROM pending_embeddings'),
    vec: count('SELECT COUNT(*) AS n FROM vec_thoughts')
  }
}

async function captureErrors<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const original = console.error
  const lines: string[] = []
  console.error = (...args: unknown[]) => {
    lines.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(' '))
  }
  try {
    return { value: await fn(), lines }
  } finally {
    console.error = original
  }
}

describe('#1574 challenge: cost, freshness, degradation parity, read-only', () => {
  test('AC2: a fully-stored pool spends 0 embedder calls and 0 vecSearchIds calls — both spies controlled live', async () => {
    await withVecDb(async () => {
      const src = seedThought({ id: 'z-src', content: 'zero cost source' })
      const near = seedThought({ id: 'z-near', content: 'zero cost near' })
      storeVec(src, vec384(0))
      storeVec(near, vec384(Math.acos(0.9)))

      const embedSpy = spyOn(embedderClient, 'generateEmbeddings')
      const vecSpy = spyOn(vectorSearchDb, 'vecSearchIds')
      try {
        const plan = await proposePlacementPlan(
          { thoughtId: src },
          { now: NOW, minSimilarity: 0.5 }
        )

        expect(plan.degraded).toBe(false)
        expect(plan.edges.map(e => e.target_id)).toEqual([near])
        const afterRun = vecSpy.mock.calls.length
        expect(embedSpy.mock.calls.length).toBe(0)
        expect(afterRun).toBe(0)

        searchThoughts(getDb(), { embedding: vec384(0), topK: 1 })
        expect(vecSpy.mock.calls.length).toBeGreaterThan(afterRun)

        process.env.SYNAPTOMIND_EMBEDDER_SCRIPT = STUB_EMBEDDER
        dropVec(near)
        const controlled = await proposePlacementPlan(
          { thoughtId: src },
          { now: NOW, minSimilarity: 0.5 }
        )

        expect(embedSpy.mock.calls.length).toBe(1)
        expect(embedSpy.mock.calls[0]![0]).toEqual(['zero cost near'])
        expect(controlled.degraded).toBe(false)
      } finally {
        embedSpy.mockRestore()
        vecSpy.mockRestore()
      }
    })
  }, 60_000)

  test('AC3: a candidate queued in pending_embeddings is scored from the LIVE vector, not the stored one', async () => {
    await withVecDb(async () => {
      const src = seedThought({ id: 'f-src', content: 'freshness source' })
      const near = seedThought({ id: 'f-near', content: 'freshness near' })
      storeVec(src, vec384(Math.PI / 2))
      storeVec(near, vec384(0))
      getDb()
        .prepare('UPDATE thoughts SET content = ? WHERE id = ?')
        .run('freshness source revised', src)
      expect(getThoughtRow(getDb(), src)!.content).toBe('freshness source revised')

      const seen: string[][] = []
      const plan = await proposePlacementPlan(
        { thoughtId: src },
        { now: NOW, minSimilarity: 0.5 },
        {
          embed: async texts => {
            seen.push(texts)
            return texts.map(() => vec384(0))
          }
        }
      )

      expect(seen).toEqual([['freshness source revised']])
      expect(plan.degraded).toBe(false)
      expect(plan.edges.map(e => e.target_id)).toEqual([near])
      expect(plan.edges[0]!.confidence).toBeCloseTo(1, 5)

      const neutral = await proposePlacementPlan(
        { thoughtId: src },
        { now: NOW, minSimilarity: 0.5 },
        { embed: async texts => texts.map(() => vec384(Math.PI / 2)) }
      )
      expect(neutral.edges).toEqual([])
    })
  })

  test('AC4: a resolved-but-wrong vector count still reports the mismatch reason', async () => {
    await withVecDb(async () => {
      const src = seedThought({ id: 'd-src', content: 'degradation source' })
      const other = seedThought({ id: 'd-other', content: 'degradation other' })
      storeVec(src, vec384(0))
      dropVec(other)
      const thought = getThoughtRow(getDb(), src)!

      const failing = await captureErrors(() =>
        proposePlacement(
          thought,
          { minSimilarity: 0.5 },
          {
            embed: async () => {
              throw new Error('embedder exploded')
            }
          }
        )
      )
      expect(failing.value.proposal).toBeNull()
      expect(failing.value.reason).toBe('embedder unavailable')

      const short = await captureErrors(() =>
        proposePlacement(
          thought,
          { minSimilarity: 0.5 },
          { embed: async texts => texts.slice(0, 0).map(() => vec384(0)) }
        )
      )
      expect(short.value.proposal).toBeNull()
      expect(short.value.reason).toBe('embedder returned a mismatched number of vectors')
      expect(short.lines.join('\n')).toContain('embedder returned 0 vectors for 1 candidates')

      const long = await captureErrors(() =>
        proposePlacement(
          thought,
          { minSimilarity: 0.5 },
          { embed: async texts => [...texts.map(() => vec384(0)), vec384(0)] }
        )
      )
      expect(long.value.proposal).toBeNull()
      expect(long.value.reason).toBe('embedder returned a mismatched number of vectors')
      expect(long.lines.join('\n')).toContain('embedder returned 2 vectors for 1 candidates')

      const healthy = await captureErrors(() =>
        proposePlacement(
          thought,
          { minSimilarity: 0.5 },
          { embed: async texts => texts.map(() => vec384(0)) }
        )
      )
      expect(DEGRADED_REASONS).not.toContain(healthy.value.reason)
      expect(healthy.lines.join('\n')).not.toContain('embedding failed')
    })
  })

  test('AC5: an injected searchNeighbors replaces the in-memory default (its verdict is the only one applied)', async () => {
    await withVecDb(async () => {
      const src = seedThought({ id: 'i-src', content: 'injection source' })
      const near = seedThought({ id: 'i-near', content: 'injection near' })
      storeVec(src, vec384(0))
      storeVec(near, vec384(0))

      const baseline = await proposePlacementPlan(
        { thoughtId: src },
        { now: NOW, minSimilarity: 0.5 }
      )
      expect(baseline.edges.map(e => e.target_id)).toEqual([near])

      const asked: string[] = []
      const injected = await proposePlacementPlan(
        { thoughtId: src },
        { now: NOW, minSimilarity: 0.5 },
        {
          searchNeighbors: id => {
            asked.push(id)
            return id === src ? [{ id: near, similarity: 0.1 }] : []
          }
        }
      )
      expect(asked.sort()).toEqual([src, near].sort())
      expect(injected.edges).toEqual([])
    })
  })

  test('AC8: the run is read-only and never throws, including on the degraded paths', async () => {
    await withVecDb(async () => {
      const cluster = seedThought({ id: 'ro-c', content: 'read only cluster', is_cluster: 1 })
      const src = seedThought({ id: 'ro-src', content: 'read only source' })
      const near = seedThought({ id: 'ro-near', content: 'read only near' })
      seedEdge(cluster, near, 'cluster')
      storeVec(src, vec384(0))
      storeVec(near, vec384(0))

      const before = rowCounts()
      const healthy = await proposePlacementPlan(
        { thoughtId: src },
        { now: NOW, minSimilarity: 0.5 }
      )
      expect(healthy.degraded).toBe(false)
      expect(healthy.edges.length).toBeGreaterThan(0)
      expect(rowCounts()).toEqual(before)

      dropVec(near)
      const beforeDegraded = rowCounts()

      const throwing = await proposePlacementPlan(
        { thoughtId: src },
        { now: NOW, minSimilarity: 0.5 },
        {
          embed: async () => {
            throw new Error('no embedder')
          }
        }
      )
      expect(throwing.degraded).toBe(true)
      expect(throwing.edges).toEqual([])
      expect(rowCounts()).toEqual(beforeDegraded)

      const short = await proposePlacementPlan(
        { thoughtId: src },
        { now: NOW, minSimilarity: 0.5 },
        { embed: async texts => texts.slice(0, 0).map(() => vec384(0)) }
      )
      expect(short.degraded).toBe(true)
      expect(rowCounts()).toEqual(beforeDegraded)
    })
  })
})
