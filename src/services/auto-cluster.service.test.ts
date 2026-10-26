import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { createTestDb, drainPendingEmbeddings, seedThought, withVecDb } from '../test/helpers'
import { closeDb } from '../db/init'
import * as searchDb from '../db/search'
import * as vectorSearchDb from '../db/search-vector'
import { config, DEFAULTS } from '../config'
import { findComponents, generateClusterTitle, groupCandidates, runAutoClusterJob } from './auto-cluster.service'
import type { ClusterCandidate } from '../db/thoughts'
import { getDb } from '../db/container'

beforeEach(createTestDb)
afterEach(closeDb)

// ── generateClusterTitle ──────────────────────────────────────────────────────

test('generateClusterTitle returns first 3 words of newest thought', () => {
  const title = generateClusterTitle([
    { content: '  lots of words here  ', created_at: '2025-01-01' },
    { content: 'this is the newest thought content', created_at: '2025-06-01' }
  ])
  expect(title).toBe('this is the')
})

test('generateClusterTitle handles single-word content', () => {
  const title = generateClusterTitle([{ content: 'single', created_at: '2025-01-01' }])
  expect(title).toBe('single')
})

// ── findComponents ───────────────────────────────────────────────────────────

test('findComponents groups connected nodes', () => {
  const components = findComponents([['a', 'b'], ['b', 'c']], ['a', 'b', 'c', 'd'])
  expect(components).toHaveLength(2)
  const groupWithD = components.find(g => g.includes('d'))
  expect(groupWithD).toEqual(['d'])
  const groupABC = components.find(g => g.includes('a'))
  expect(groupABC!.sort()).toEqual(['a', 'b', 'c'])
})

test('findComponents handles no pairs', () => {
  const components = findComponents([], ['a', 'b'])
  expect(components).toHaveLength(2)
})

test('findComponents handles all connected', () => {
  const components = findComponents([['a', 'b'], ['b', 'c'], ['c', 'd']], ['a', 'b', 'c', 'd'])
  expect(components).toHaveLength(1)
  expect(components[0].sort()).toEqual(['a', 'b', 'c', 'd'])
})

// ── groupCandidates ──────────────────────────────────────────────────────────

test('groupCandidates groups by neighbor function', () => {
  const candidates: ClusterCandidate[] = [
    { id: '1', content: 'a', status: 'active', created_at: '2025-01-01', tags: [], source: null, project_id: 'default' },
    { id: '2', content: 'b', status: 'active', created_at: '2025-01-02', tags: [], source: null, project_id: 'default' },
    { id: '3', content: 'c', status: 'active', created_at: '2025-01-03', tags: [], source: null, project_id: 'default' }
  ]
  const neighborFn = (id: string): string[] => {
    if (id === '1') return ['2']
    if (id === '2') return ['1', '3']
    if (id === '3') return ['2']
    return []
  }
  const groups = groupCandidates(candidates, neighborFn, 2)
  expect(groups.length).toBeGreaterThanOrEqual(1)
  expect(groups.some(g => g.includes('1') && g.includes('2') && g.includes('3'))).toBeTrue()
})

test('groupCandidates filters groups smaller than minMembers', () => {
  const candidates: ClusterCandidate[] = [
    { id: '1', content: 'a', status: 'active', created_at: '2025-01-01', tags: [], source: null, project_id: 'default' },
    { id: '2', content: 'b', status: 'active', created_at: '2025-01-02', tags: [], source: null, project_id: 'default' }
  ]
  const groups = groupCandidates(candidates, () => [], 3)
  expect(groups).toHaveLength(0)
})

// ── runAutoClusterJob ────────────────────────────────────────────────────────

test('runAutoClusterJob returns empty when no candidates', async () => {
  const result = await runAutoClusterJob({ minAgeDays: 999, dryRun: true })
  expect(result.candidates).toBe(0)
  expect(result.clusters_created).toBe(0)
})

test('runAutoClusterJob dry run does not create clusters', async () => {
  const result = await runAutoClusterJob({ dryRun: true, minAgeDays: 0 })
  expect(result.dry_run).toBeTrue()
  expect(result.clusters_created).toBe(0)
})

// ── runAutoClusterJob with injected embed + searchNeighbors ───────────────────

/**
 * Build four past-dated thoughts and return their IDs in order [A, B, C, D].
 * minAgeDays=0 ensures they are all eligible candidates.
 */
function seedFourThoughts(): string[] {
  const past = new Date(Date.now() - 10 * 86400000).toISOString()
  return ['A', 'B', 'C', 'D'].map(tag => seedThought({ content: `thought ${tag}`, created_at: past }))
}

test('runAutoClusterJob: minSimilarity 0.3 groups A-B only (distances 0.25/0.5/0.6, minMembers=2)', async () => {
  const ids = seedFourThoughts()
  const dist: Record<string, number> = {
    [`${ids[0]}|${ids[1]}`]: 0.25, [`${ids[1]}|${ids[0]}`]: 0.25,
    [`${ids[1]}|${ids[2]}`]: 0.5,  [`${ids[2]}|${ids[1]}`]: 0.5,
    [`${ids[2]}|${ids[3]}`]: 0.6,  [`${ids[3]}|${ids[2]}`]: 0.6
  }
  const deps = {
    embed: async (_texts: string[]) => _texts.map(() => new Float32Array(384)),
    searchNeighbors: (id: string) =>
      ids.filter(x => x !== id).map(x => ({ id: x, distance: dist[`${id}|${x}`] ?? 0.9 }))
  }
  const result = await runAutoClusterJob(
    { minAgeDays: 0, minMembers: 2, minSimilarity: 0.3, dryRun: true },
    deps
  )
  expect(result.groups).toHaveLength(1)
  expect(result.groups[0].members.length).toBe(2)
  expect(result.groups[0].members).toEqual(expect.arrayContaining([ids[0], ids[1]]))
})

test('runAutoClusterJob: minSimilarity 0.68 groups all four (distances 0.25/0.5/0.6, minMembers=2)', async () => {
  const ids = seedFourThoughts()
  const dist: Record<string, number> = {
    [`${ids[0]}|${ids[1]}`]: 0.25, [`${ids[1]}|${ids[0]}`]: 0.25,
    [`${ids[1]}|${ids[2]}`]: 0.5,  [`${ids[2]}|${ids[1]}`]: 0.5,
    [`${ids[2]}|${ids[3]}`]: 0.6,  [`${ids[3]}|${ids[2]}`]: 0.6
  }
  const deps = {
    embed: async (_texts: string[]) => _texts.map(() => new Float32Array(384)),
    searchNeighbors: (id: string) =>
      ids.filter(x => x !== id).map(x => ({ id: x, distance: dist[`${id}|${x}`] ?? 0.9 }))
  }
  const result = await runAutoClusterJob(
    { minAgeDays: 0, minMembers: 2, minSimilarity: 0.68, dryRun: true },
    deps
  )
  expect(result.groups).toHaveLength(1)
  expect(result.groups[0].members.length).toBe(4)
  expect(result.groups[0].members).toEqual(expect.arrayContaining(ids))
})

test('runAutoClusterJob: omitted minSimilarity falls back to config default (recalibrated 0.09)', async () => {
  const ids = seedFourThoughts()
  const dist: Record<string, number> = {
    [`${ids[0]}|${ids[1]}`]: 0.05, [`${ids[1]}|${ids[0]}`]: 0.05,
    [`${ids[1]}|${ids[2]}`]: 0.5,  [`${ids[2]}|${ids[1]}`]: 0.5,
    [`${ids[2]}|${ids[3]}`]: 0.6,  [`${ids[3]}|${ids[2]}`]: 0.6
  }
  const deps = {
    embed: async (_texts: string[]) => _texts.map(() => new Float32Array(384)),
    searchNeighbors: (id: string) =>
      ids.filter(x => x !== id).map(x => ({ id: x, distance: dist[`${id}|${x}`] ?? 0.9 }))
  }
  // minSimilarity omitted — should use config.autoCluster.minSimilarity (= DEFAULTS.autoCluster.minSimilarity after recalibration)
  const result = await runAutoClusterJob(
    { minAgeDays: 0, minMembers: 2, dryRun: true },
    deps
  )
  expect(result.groups).toHaveLength(1)
  expect(result.groups[0].members.length).toBe(2)
  expect(result.groups[0].members).toEqual(expect.arrayContaining([ids[0], ids[1]]))
})

test('runAutoClusterJob: explicit minSimilarity overrides config default after recalibration', async () => {
  // Same distance layout as the 0.3 test: A-B=0.25, B-C=0.5, C-D=0.6.
  // Passing minSimilarity=0.3 explicitly should group only A-B (2 members),
  // proving the explicit option still wins over the recalibrated default.
  const ids = seedFourThoughts()
  const dist: Record<string, number> = {
    [`${ids[0]}|${ids[1]}`]: 0.25, [`${ids[1]}|${ids[0]}`]: 0.25,
    [`${ids[1]}|${ids[2]}`]: 0.5,  [`${ids[2]}|${ids[1]}`]: 0.5,
    [`${ids[2]}|${ids[3]}`]: 0.6,  [`${ids[3]}|${ids[2]}`]: 0.6
  }
  const deps = {
    embed: async (_texts: string[]) => _texts.map(() => new Float32Array(384)),
    searchNeighbors: (id: string) =>
      ids.filter(x => x !== id).map(x => ({ id: x, distance: dist[`${id}|${x}`] ?? 0.9 }))
  }
  const result = await runAutoClusterJob(
    { minAgeDays: 0, minMembers: 2, minSimilarity: 0.3, dryRun: true },
    deps
  )
  expect(result.groups).toHaveLength(1)
  expect(result.groups[0].members.length).toBe(2)
  expect(result.groups[0].members).toEqual(expect.arrayContaining([ids[0], ids[1]]))
  // Sanity: the default from config/DEFAULTS is the recalibrated value, not the old 0.3.
  expect(config.autoCluster.minSimilarity).toBe(DEFAULTS.autoCluster.minSimilarity)
  expect(DEFAULTS.autoCluster.minSimilarity).toBe(0.09)
})

// ── Stored-vector path: no re-embedding, in-memory neighbours (task #1566) ────

/**
 * Store one vector for `id` and drain its queued re-embed — the state a
 * candidate reaches after the embedder worker refreshed its `vec_thoughts` row.
 * A candidate left in `pending_embeddings` is embedded live from its content
 * instead of scored from the stale vector (task #1569, R1).
 */
function storeVec(id: string, vector: Float32Array): void {
  getDb()
    .prepare(`INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)`)
    .run(id, Buffer.from(vector.buffer as ArrayBuffer, vector.byteOffset, vector.byteLength))
  drainPendingEmbeddings([id])
}

/**
 * Bulk-seed `count` eligible candidates with stored 384-dim vectors.
 *
 * `seedThought()` per row is far too slow for a bulk seed — the 200-candidate
 * gate check and the 3000-candidate perf run in `auto-cluster.perf.suite.ts` —
 * so the insert is one transaction; every seeded vector is `[1, 0, 0, ...]`, so
 * every pair is at distance 0 and a single run groups all of them together.
 */
function seedClusterCandidates(count: number, past: string): string[] {
  const db = getDb()
  const ids: string[] = []
  const vector = new Float32Array(384)
  vector[0] = 1
  const buffer = Buffer.from(vector.buffer as ArrayBuffer, vector.byteOffset, vector.byteLength)
  const insertThought = db.prepare(`
    INSERT INTO thoughts (id, content, status, source, project_id, is_cluster, is_protected, is_global, created_at, updated_at)
    VALUES (?, ?, 'active', 'test', 'default', 0, 1, 0, ?, ?)
  `)
  const insertVec = db.prepare(`INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)`)
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `11111111-1111-7111-8111-${String(i).padStart(12, '0')}`
      ids.push(id)
      insertThought.run(id, `bulk candidate ${i}`, past, past)
      insertVec.run(id, buffer)
    }
  })()
  drainPendingEmbeddings(ids)
  return ids
}

test('runAutoClusterJob: makes 0 embedder calls when every candidate has a stored vector', async () => {
  await withVecDb(async () => {
    const past = new Date(Date.now() - 10 * 86400000).toISOString()
    const ids = ['A', 'B', 'C'].map(tag => seedThought({ content: `thought ${tag}`, created_at: past }))
    const vector = new Float32Array(384)
    vector[0] = 1
    for (const id of ids) storeVec(id, vector)

    let embedCalls = 0
    const result = await runAutoClusterJob(
      { minAgeDays: 0, minMembers: 2, minSimilarity: 0.3, dryRun: true },
      {
        embed: async texts => {
          embedCalls++
          return texts.map(() => new Float32Array(384))
        }
      }
    )

    expect(embedCalls).toBe(0)
    expect(result.candidates).toBe(3)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].members.length).toBe(3)
  })
})

test('runAutoClusterJob: embeds only the candidates missing a stored vector, in candidate order', async () => {
  await withVecDb(async () => {
    const past = new Date(Date.now() - 10 * 86400000).toISOString()
    const ids = ['A', 'B', 'C'].map(tag => seedThought({ content: `thought ${tag}`, created_at: past }))
    const stored = new Float32Array(384)
    stored[0] = 1
    // The newest candidate (listClusterCandidates orders created_at DESC) is the gap.
    storeVec(ids[2], stored)

    const seen: string[][] = []
    const result = await runAutoClusterJob(
      { minAgeDays: 0, minMembers: 2, minSimilarity: 0.3, dryRun: true },
      {
        embed: async texts => {
          seen.push(texts)
          return texts.map(() => new Float32Array(384))
        }
      }
    )

    expect(seen).toHaveLength(1)
    expect(seen[0]).toHaveLength(2)
    expect(seen[0]).toEqual(expect.arrayContaining(['thought A', 'thought B']))
    expect(seen[0]).not.toContain('thought C')
    expect(result.candidates).toBe(3)
  })
})

test('runAutoClusterJob: group composition is unchanged with stored vectors (in-memory distances)', async () => {
  await withVecDb(async () => {
    const past = new Date(Date.now() - 10 * 86400000).toISOString()
    const ids = ['A', 'B', 'C', 'D'].map(tag => seedThought({ content: `thought ${tag}`, created_at: past }))
    // Pairwise distances A-B 0.05 / B-C 0.25 / C-D 0.5, plus the 0.6 pair, the
    // distances the injected-lookup fixtures calibrate against. Each candidate
    // sits at a cumulative angle delta where `cos(delta) = 1 - distance`, so the
    // stored cosines are exact in float64 and both thresholds stay unambiguous:
    // 0.09 admits only A-B, 0.3 admits the A-B-C chain.
    const angles = [0, angleForDistance(0.05)]
    for (const distance of [0.25, 0.5]) angles.push(angles[angles.length - 1]! + angleForDistance(distance))
    for (let i = 0; i < ids.length; i++) storeVec(ids[i]!, clusterVec(angles[i]!))

    // 0.3 (explicit): the 0.05 and 0.25 links connect → the A-B-C chain.
    const strict = await runAutoClusterJob({ minAgeDays: 0, minMembers: 2, minSimilarity: 0.3, dryRun: true })
    expect(strict.groups).toHaveLength(1)
    expect(strict.groups[0].members.length).toBe(3)
    expect(strict.groups[0].members).toEqual(expect.arrayContaining([ids[0], ids[1], ids[2]]))

    // 0.09 (calibrated config default): only the 0.05 link clears it → A-B.
    // `minMembers` stays explicit so this compares thresholds, not defaults.
    const relaxed = await runAutoClusterJob({ minAgeDays: 0, minMembers: 2, minSimilarity: 0.09, dryRun: true })
    expect(relaxed.groups).toHaveLength(1)
    expect(relaxed.groups[0].members.length).toBe(2)
    expect(relaxed.groups[0].members).toEqual(expect.arrayContaining([ids[0], ids[1]]))
  })
})

test('runAutoClusterJob: the default path issues no per-candidate vec0 search', async () => {
  await withVecDb(async () => {
    const past = new Date(Date.now() - 10 * 86400000).toISOString()
    const ids = ['A', 'B', 'C'].map(tag => seedThought({ content: `thought ${tag}`, created_at: past }))
    const vector = new Float32Array(384)
    vector[0] = 1
    for (const id of ids) storeVec(id, vector)

    const searchSpy = spyOn(searchDb, 'searchThoughts')
    const result = await runAutoClusterJob({ minAgeDays: 0, minMembers: 2, minSimilarity: 0.3, dryRun: true })

    expect(searchSpy.mock.calls.length).toBe(0)
    expect(result.groups).toHaveLength(1)
    searchSpy.mockRestore()
  })
})

test('runAutoClusterJob: 200 stored-vector candidates need 0 embedder calls and reach one group', async () => {
  await withVecDb(async () => {
    const past = new Date(Date.now() - 10 * 86400000).toISOString()
    // Small N on purpose: the 3000-candidate timing run is an O(N^2) job that
    // would carry a multi-second load into the default gate on a host that also
    // runs prod (AGENTS.md §8), so it lives in `auto-cluster.perf.suite.ts`
    // (task #1569, O4). This keeps the same stored-vector path — bulk seeding,
    // zero embedder calls, in-memory neighbours — pinned for correctness.
    const ids = seedClusterCandidates(200, past)
    let embedCalls = 0

    const result = await runAutoClusterJob(
      { minAgeDays: 0, minMembers: 2, minSimilarity: 0.3, dryRun: true },
      {
        embed: async texts => {
          embedCalls++
          return texts.map(() => new Float32Array(384))
        }
      }
    )

    expect(embedCalls).toBe(0)
    expect(result.candidates).toBe(200)
    // Every stored vector is [1, 0, ...]: all pairs at distance 0, so one group.
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].members.length).toBe(ids.length)
  })
})

// ── Threshold convention, pre-change equivalence, DI seam (task #1567) ───────

/** Unit vector at `angle`: `cos(A, B) = cos(angleA - angleB)`, so distances are exact. */
function clusterVec(angle: number): Float32Array {
  const v = new Float32Array(384)
  v[0] = Math.cos(angle)
  v[1] = Math.sin(angle)
  return v
}

/** Angle whose cosine with angle 0 is `1 - distance`. */
const angleForDistance = (distance: number): number => Math.acos(1 - distance)

function storeClusterVec(id: string, angle: number): void {
  storeVec(id, clusterVec(angle))
}

/** Eligible cluster candidate: active, past-dated, no cluster edges. */
function seedOldThought(content: string): string {
  return seedThought({ content, created_at: new Date(Date.now() - 10 * 86400000).toISOString() })
}

/** Groups as order-insensitive sets, for comparing group composition. */
function groupSets(groups: Array<{ members: string[] }>): string[][] {
  return groups.map(g => [...g.members].sort()).sort((a, b) => a[0]!.localeCompare(b[0]!))
}

test('runAutoClusterJob: stored-vector groups match the injected pre-change lookup (0.05/0.25/0.5/0.6)', async () => {
  // Chain fixture from the contract: consecutive distances 0.05 / 0.25 / 0.5 /
  // 0.6, so 0.09 admits only A-B and 0.3 admits the A-B-C chain.
  const links = [0.05, 0.25, 0.5, 0.6]
  const angles = [0]
  for (const distance of links) angles.push(angles[angles.length - 1]! + angleForDistance(distance))

  for (const minSimilarity of [0.09, 0.3]) {
    await withVecDb(async () => {
      const ids = ['A', 'B', 'C', 'D', 'E'].map(tag => seedOldThought(`thought ${tag}`))
      ids.forEach((id, i) => {
        storeClusterVec(id, angles[i]!)
      })

      // The pre-change shape: a neighbour lookup returning every other candidate
      // with its cosine distance, filtered by `neighborFn` exactly as before.
      const indexOf = (id: string): number => ids.indexOf(id)
      const injected = (id: string, _embedding: Float32Array, topK: number) =>
        ids
          .filter(other => other !== id)
          .map(other => ({
            id: other,
            distance: 1 - Math.cos(angles[indexOf(id)]! - angles[indexOf(other)]!)
          }))
          .sort((a, b) => a.distance - b.distance)
          .slice(0, topK)

      const inMemory = await runAutoClusterJob({ minAgeDays: 0, minMembers: 2, minSimilarity, dryRun: true })
      const preChange = await runAutoClusterJob(
        { minAgeDays: 0, minMembers: 2, minSimilarity, dryRun: true },
        { searchNeighbors: injected }
      )

      const expected = minSimilarity === 0.09 ? [[ids[0]!, ids[1]!]] : [[ids[0]!, ids[1]!, ids[2]!]]
      expect(groupSets(inMemory.groups)).toEqual(expected)
      expect(groupSets(preChange.groups)).toEqual(expected)
      expect(groupSets(inMemory.groups)).toEqual(groupSets(preChange.groups))
    })
  }
})

test('runAutoClusterJob: minSimilarity is a DISTANCE threshold, not a similarity one', async () => {
  await withVecDb(async () => {
    const ids = ['X', 'Y', 'Z'].map(tag => seedOldThought(`thought ${tag}`))
    // cos(X,Y) = 0.10 (distance 0.90) and cos(X,Z) = 0.92 (distance 0.08): the
    // pair straddles the 0.09 threshold symmetrically, so reading a distance as
    // a similarity flips it from excluded to included.
    storeClusterVec(ids[0]!, 0)
    storeClusterVec(ids[1]!, Math.acos(0.1))
    storeClusterVec(ids[2]!, -Math.acos(0.92))

    const result = await runAutoClusterJob({ minAgeDays: 0, minMembers: 2, minSimilarity: 0.09, dryRun: true })

    // Only the 0.08-distance pair is a link; 0.90 (similarity 0.10 >= 0.09) is not.
    expect(groupSets(result.groups)).toEqual([[ids[0]!, ids[2]!].sort()])
  })
})

test('runAutoClusterJob: an injected searchNeighbors overrides the in-memory default', async () => {
  await withVecDb(async () => {
    const ids = ['A', 'B', 'C'].map(tag => seedOldThought(`thought ${tag}`))
    // Identical stored vectors: the in-memory path would see distance 0 for all
    // pairs and group all three. The injected lookup reports 0.9 instead, so a
    // surviving group would prove the injected function was ignored.
    for (const id of ids) storeClusterVec(id, 0)
    let injectedCalls = 0
    const injected = (id: string, _embedding: Float32Array, _topK: number) => {
      injectedCalls++
      return ids.filter(other => other !== id).map(other => ({ id: other, distance: 0.9 }))
    }

    const result = await runAutoClusterJob(
      { minAgeDays: 0, minMembers: 2, minSimilarity: 0.09, dryRun: true },
      { searchNeighbors: injected }
    )

    expect(injectedCalls).toBe(ids.length)
    expect(result.groups).toEqual([])
  })
})

test('runAutoClusterJob: a mixed run (stored + embedded) reaches every candidate', async () => {
  await withVecDb(async () => {
    const ids = ['A', 'B', 'C'].map(tag => seedOldThought(`thought ${tag}`))
    storeClusterVec(ids[0]!, 0)
    storeClusterVec(ids[1]!, Math.acos(0.92))
    const seen: string[][] = []

    const result = await runAutoClusterJob(
      { minAgeDays: 0, minMembers: 2, minSimilarity: 0.3, dryRun: true },
      {
        embed: async texts => {
          seen.push(texts)
          // C is embedded at B's angle: distance 0 to B, 0.08 to A.
          return texts.map(() => clusterVec(Math.acos(0.92)))
        }
      }
    )

    expect(seen).toEqual([['thought C']])
    expect(result.candidates).toBe(3)
    expect(groupSets(result.groups)).toEqual([[...ids].sort()])
  })
})

test('runAutoClusterJob: the freshly embedded vector is used for the missing candidate', async () => {
  await withVecDb(async () => {
    const ids = ['A', 'B', 'C'].map(tag => seedOldThought(`thought ${tag}`))
    storeClusterVec(ids[0]!, 0)
    storeClusterVec(ids[1]!, Math.acos(0.92))

    const result = await runAutoClusterJob(
      { minAgeDays: 0, minMembers: 2, minSimilarity: 0.09, dryRun: true },
      {
        // Orthogonal to both stored vectors. A misaligned matrix (C receiving
        // A's or B's vector) would merge C into the group instead.
        embed: async texts => texts.map(() => clusterVec(Math.PI / 2))
      }
    )

    expect(result.candidates).toBe(3)
    expect(groupSets(result.groups)).toEqual([[ids[0]!, ids[1]!].sort()])
  })
})

test('runAutoClusterJob: the default path runs no vec0 neighbour query (spy + positive control)', async () => {
  await withVecDb(async () => {
    const ids = ['A', 'B', 'C'].map(tag => seedOldThought(`thought ${tag}`))
    for (const id of ids) storeClusterVec(id, 0)
    const vectorSpy = spyOn(vectorSearchDb, 'vecSearchIds')
    let afterRun = -1
    try {
      const result = await runAutoClusterJob({ minAgeDays: 0, minMembers: 2, minSimilarity: 0.09, dryRun: true })
      afterRun = vectorSpy.mock.calls.length
      expect(result.groups).toHaveLength(1)

      // Positive control: the spy does observe this query path, so a count of 0
      // in the service run is evidence rather than a dead spy.
      searchDb.searchThoughts(getDb(), { embedding: clusterVec(0), topK: 1 })
      expect(vectorSpy.mock.calls.length).toBeGreaterThan(afterRun)
    } finally {
      vectorSpy.mockRestore()
    }
    expect(afterRun).toBe(0)
  })
})

test('runAutoClusterJob: a wrong-count embedder reply propagates instead of degrading', async () => {
  const ids = ['A', 'B', 'C'].map(tag => seedOldThought(`thought ${tag}`))
  expect(ids).toHaveLength(3)

  // `:memory:` stores nothing, so all three candidates are missing and the
  // embedder owes three vectors. Unlike edge-detect / auto-link, auto-cluster
  // has no try/catch around the resolver: the mismatch surfaces to the caller.
  await expect(
    runAutoClusterJob(
      { minAgeDays: 0, minMembers: 2, dryRun: true },
      { embed: async () => [clusterVec(0)] }
    )
  ).rejects.toThrow('embedder returned 1 vectors for 3 candidates')
})
