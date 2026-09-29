import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb } from '../db/init'
import { config, DEFAULTS } from '../config'
import { findComponents, generateClusterTitle, groupCandidates, getLastAutoClusterStatus, runAutoClusterJob } from './auto-cluster.service'
import type { ClusterCandidate } from '../db/thoughts'

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
  const result = await runAutoClusterJob({ minAgeDays: 999 })
  expect(result.candidates).toBe(0)
  expect(result.clusters_created).toBe(0)
})

test('runAutoClusterJob dry run does not create clusters', async () => {
  const result = await runAutoClusterJob({ dryRun: true, minAgeDays: 0 })
  expect(result.dry_run).toBeTrue()
  expect(result.clusters_created).toBe(0)
})

test('getLastAutoClusterStatus returns null before any run', () => {
  expect(getLastAutoClusterStatus().last_run).toBeNull()
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
