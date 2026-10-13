import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { createTestDb, drainPendingEmbeddings, seedEdge, seedThought, withVecDb } from '../test/helpers'
import { closeDb } from '../db'
import * as searchDb from '../db/search'
import * as vectorSearchDb from '../db/search-vector'
import { pairKey } from '../db/utils'
import { getDb } from '../db/container'
import {
  createEdges,
  findLinkCandidates,
  mergeCandidates,
  runAutoLinkJob
} from './auto-link.service'
import type { CandidatePair } from './auto-link.service'

beforeEach(createTestDb)
afterEach(closeDb)

// ── findLinkCandidates ────────────────────────────────────────────────────────

test('findLinkCandidates returns active non-cluster thoughts with < 3 edges', () => {
  const a = seedThought({ content: 'a' })
  const b = seedThought({ content: 'b' })
  seedThought({ content: 'cluster', is_cluster: 1 })
  seedThought({ status: 'archived' })
  seedEdge(a, b, 'related')
  const candidates = findLinkCandidates()
  expect(candidates.length).toBeGreaterThanOrEqual(2)
  expect(candidates.every(c => c.edge_count < 3)).toBeTrue()
})

test('findLinkCandidates excludes cluster members', () => {
  const cluster = seedThought({ is_cluster: 1 })
  const member = seedThought()
  seedEdge(cluster, member, 'cluster')
  const candidates = findLinkCandidates()
  expect(candidates.find(c => c.id === member)).toBeUndefined()
})

// ── mergeCandidates ──────────────────────────────────────────────────────────

test('mergeCandidates keeps the max similarity for an unordered pair', () => {
  const pairs: CandidatePair[] = [
    { source_id: 'b', target_id: 'a', embeddingSimilarity: 0.7, score: 0.7 },
    { source_id: 'a', target_id: 'b', embeddingSimilarity: 0.9, score: 0.9 }
  ]
  const merged = mergeCandidates(pairs, 10)
  expect(merged).toHaveLength(1)
  expect(merged[0].embeddingSimilarity).toBeCloseTo(0.9)
  expect(merged[0].score).toBeCloseTo(0.9)
})

test('mergeCandidates sorts by score descending and limits to maxEdges', () => {
  const pairs: CandidatePair[] = [
    { source_id: 'a', target_id: 'b', embeddingSimilarity: 0.6, score: 0.6 },
    { source_id: 'c', target_id: 'd', embeddingSimilarity: 0.95, score: 0.95 }
  ]
  const result = mergeCandidates(pairs, 1)
  expect(result).toHaveLength(1)
  expect(result[0].source_id).toBe('c')
})

// ── createEdges ──────────────────────────────────────────────────────────────

test('createEdges creates related edges for pairs', () => {
  const a = seedThought()
  const b = seedThought()
  const pairs: CandidatePair[] = [
    { source_id: a, target_id: b, embeddingSimilarity: 0.9, score: 0.9 }
  ]
  const created = createEdges(pairs)
  expect(created).toHaveLength(1)
  expect(created[0].type).toBe('related')
})

test('createEdges skips existing edges silently', () => {
  const a = seedThought()
  const b = seedThought()
  seedEdge(a, b, 'related')
  const pairs: CandidatePair[] = [
    { source_id: a, target_id: b, embeddingSimilarity: 0.9, score: 0.9 }
  ]
  const created = createEdges(pairs)
  // createEdges catches EdgeAlreadyExistsError, so no duplicate is created
  expect(created.length).toBeLessThanOrEqual(1)
})

// ── runAutoLinkJob ───────────────────────────────────────────────────────────

test('runAutoLinkJob returns empty result with < 2 candidates', async () => {
  seedThought()
  const result = await runAutoLinkJob({}, { embed: async () => [new Float32Array(384)] })
  expect(result.candidates).toBe(1)
  expect(result.pairs_found).toBe(0)
  expect(result.edges_created).toBe(0)
})

test('runAutoLinkJob dry run does not create edges', async () => {
  seedThought({ content: 'first thought about topic X' })
  seedThought({ content: 'second thought about topic X' })
  const result = await runAutoLinkJob(
    { dryRun: true },
    { embed: async () => [new Float32Array(384), new Float32Array(384)] }
  )
  expect(result.dry_run).toBeTrue()
  expect(result.edges_created).toBe(0)
})

// ── Stored-vector path: no re-embedding, in-memory neighbours (task #1566) ────

/**
 * Store one 384-dim vector (vec_thoughts is `FLOAT[384]`) and drain the
 * candidate's queued re-embed — the state after the worker refreshed it. A row
 * left in `pending_embeddings` is embedded live instead (task #1569, R1).
 */
function storeVec(id: string, angle: number): void {
  const v = new Float32Array(384)
  v[0] = Math.cos(angle)
  v[1] = Math.sin(angle)
  getDb()
    .prepare(`INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)`)
    .run(id, Buffer.from(v.buffer as ArrayBuffer, v.byteOffset, v.byteLength))
  drainPendingEmbeddings([id])
}

test('runAutoLinkJob makes 0 embedder calls when every candidate has a stored vector', async () => {
  await withVecDb(async () => {
    const a = seedThought({ content: 'first thought about topic X' })
    const b = seedThought({ content: 'second thought about topic X' })
    // cos(A, B) = 0.9 → similarity 0.9, above the 0.65 autoLink threshold.
    storeVec(a, 0)
    storeVec(b, Math.acos(0.9))
    let embedCalls = 0

    const result = await runAutoLinkJob(
      { dryRun: true },
      {
        embed: async texts => {
          embedCalls++
          return texts.map(() => new Float32Array(384))
        }
      }
    )

    expect(embedCalls).toBe(0)
    expect(result.candidates).toBe(2)
    expect(result.pairs_found).toBe(1)
    expect(result.pairs[0].embeddingSimilarity).toBeCloseTo(0.9, 4)
  })
})

test('runAutoLinkJob embeds only the candidates missing a stored vector, in candidate order', async () => {
  await withVecDb(async () => {
    const a = seedThought({ content: 'first thought about topic X' })
    seedThought({ content: 'second thought about topic X' })
    seedThought({ content: 'third thought about topic X' })
    storeVec(a, 0)
    const seen: string[][] = []

    const result = await runAutoLinkJob(
      { dryRun: true },
      {
        embed: async texts => {
          seen.push(texts)
          return texts.map(() => new Float32Array(384))
        }
      }
    )

    expect(seen).toHaveLength(1)
    expect(seen[0]).toHaveLength(2)
    expect(seen[0]).not.toContain('first thought about topic X')
    expect(result.candidates).toBe(3)
  })
})

// ── Coverage, threshold convention, DI seam (task #1567) ─────────────────────

/** Unit vector at `angle`: `cos(A, B) = cos(angleA - angleB)`, so similarities are exact. */
function angleVec(angle: number): Float32Array {
  const v = new Float32Array(384)
  v[0] = Math.cos(angle)
  v[1] = Math.sin(angle)
  return v
}

const pairKeys = (pairs: Array<{ source_id: string; target_id: string }>): Set<string> =>
  new Set(pairs.map(p => pairKey(p.source_id, p.target_id)))

test('runAutoLinkJob: a mixed run embeds the missing candidates in candidate order and pairs them', async () => {
  await withVecDb(async () => {
    const contents = new Map([
      [seedThought({ content: 'first thought about topic X' }), 'first thought about topic X'],
      [seedThought({ content: 'second thought about topic X' }), 'second thought about topic X'],
      [seedThought({ content: 'third thought about topic X' }), 'third thought about topic X']
    ])
    const [a, b, c] = [...contents.keys()] as [string, string, string]
    storeVec(a, 0)
    storeVec(b, Math.acos(0.92))
    const missing = findLinkCandidates()
      .map(candidate => candidate.id)
      .filter(id => id !== a && id !== b)
    expect(missing).toEqual([c])

    const seen: string[][] = []
    const result = await runAutoLinkJob(
      { dryRun: true, minSimilarity: 0.09 },
      {
        embed: async texts => {
          seen.push(texts)
          // C is embedded at B's angle: it pairs with both stored candidates.
          return texts.map(() => angleVec(Math.acos(0.92)))
        }
      }
    )

    // Exactly the missing contents, in the order `findLinkCandidates` returned.
    expect(seen).toEqual([missing.map(id => contents.get(id)!)])
    expect(result.candidates).toBe(3)
    expect(pairKeys(result.pairs)).toEqual(new Set([pairKey(a, b), pairKey(a, c), pairKey(b, c)]))
  })
})

test('runAutoLinkJob: minSimilarity is a SIMILARITY threshold, not a distance one', async () => {
  await withVecDb(async () => {
    const x = seedThought({ content: 'xray' })
    const y = seedThought({ content: 'yankee' })
    const z = seedThought({ content: 'zulu' })
    // cos(X,Y) = 0.10 (distance 0.90) and cos(X,Z) = 0.92 (distance 0.08): the
    // pairs straddle the 0.09 threshold symmetrically, so reading a distance as
    // a similarity drops the 0.92-similarity pair.
    storeVec(x, 0)
    storeVec(y, Math.acos(0.1))
    storeVec(z, -Math.acos(0.92))

    const result = await runAutoLinkJob({ dryRun: true, minSimilarity: 0.09 })

    expect(pairKeys(result.pairs)).toEqual(new Set([pairKey(x, y), pairKey(x, z)]))
    const similarities = result.pairs.map(p => p.embeddingSimilarity)
    expect(similarities).toHaveLength(2)
    expect(similarities[0]).toBeCloseTo(0.92, 4)
    expect(similarities[1]).toBeCloseTo(0.1, 4)
  })
})

test('runAutoLinkJob: an injected searchNeighbors overrides the in-memory default', async () => {
  await withVecDb(async () => {
    const a = seedThought({ content: 'first thought about topic X' })
    const b = seedThought({ content: 'second thought about topic X' })
    // Orthogonal vectors: the in-memory lookup sees no pair at all, so the only
    // possible source of a 0.99-similarity pair is the injected lookup.
    storeVec(a, 0)
    storeVec(b, Math.PI / 2)

    const plain = await runAutoLinkJob({ dryRun: true, minSimilarity: 0.09 })
    expect(plain.pairs).toEqual([])

    let calls = 0
    const injected = (id: string) => {
      calls++
      return [{ id: id === a ? b : a, similarity: 0.99 }]
    }
    const overridden = await runAutoLinkJob({ dryRun: true, minSimilarity: 0.09 }, { searchNeighbors: injected })

    expect(calls).toBe(2)
    expect(overridden.pairs).toHaveLength(1)
    expect(overridden.pairs[0]!.embeddingSimilarity).toBeCloseTo(0.99, 5)
    expect(overridden.pairs[0]!.score).toBeCloseTo(0.99, 5)
  })
})

test('runAutoLinkJob: the default path runs no vec0 neighbour query (spy + positive control)', async () => {
  await withVecDb(async () => {
    const a = seedThought({ content: 'first thought about topic X' })
    const b = seedThought({ content: 'second thought about topic X' })
    storeVec(a, 0)
    storeVec(b, Math.acos(0.92))

    const vectorSpy = spyOn(vectorSearchDb, 'vecSearchIds')
    try {
      const result = await runAutoLinkJob({ dryRun: true, minSimilarity: 0.09 })
      expect(result.pairs_found).toBe(1)
      const afterRun = vectorSpy.mock.calls.length

      // Positive control: the spy observes this query path, so 0 during the
      // service run is evidence rather than a dead spy (auto-link no longer
      // imports `searchThoughts`, so spying on it would be vacuous).
      searchDb.searchThoughts(getDb(), { embedding: angleVec(0), topK: 1 })
      expect(vectorSpy.mock.calls.length).toBeGreaterThan(afterRun)
      expect(afterRun).toBe(0)
    } finally {
      vectorSpy.mockRestore()
    }
  })
})

test('runAutoLinkJob: without vec_thoughts the in-memory path still finds pairs (:memory:)', async () => {
  createTestDb()
  seedThought({ content: 'first thought about topic X' })
  seedThought({ content: 'second thought about topic X' })

  // Pre-change this run produced no pairs: the vec0 neighbour search threw and
  // the per-candidate catch returned []. The batch read now degrades to "no
  // stored vectors" and the comparison happens in memory instead.
  const result = await runAutoLinkJob(
    { dryRun: true, minSimilarity: 0.09 },
    { embed: async texts => texts.map(() => angleVec(0)) }
  )

  expect(result.candidates).toBe(2)
  expect(result.pairs_found).toBe(1)
})

test('runAutoLinkJob: an embedder failure aborts pair discovery without throwing (parity with edge-detect)', async () => {
  await withVecDb(async () => {
    const a = seedThought({ content: 'first thought about topic X' })
    seedThought({ content: 'second thought about topic X' })
    storeVec(a, 0)

    // The resolver throws on a wrong-count reply; the outer try/catch turns it
    // into a pair-less run, matching the pre-change behaviour (the embed call
    // already sat inside that try block).
    const result = await runAutoLinkJob(
      { dryRun: true, minSimilarity: 0.09 },
      { embed: async () => [] }
    )

    expect(result.candidates).toBe(2)
    expect(result.pairs_found).toBe(0)
    expect(result.pairs).toEqual([])
  })
})
