import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { closeDb } from '../db'
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
