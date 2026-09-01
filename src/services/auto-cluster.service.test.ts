import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb } from '../test/helpers'
import { closeDb } from '../db/init'
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
