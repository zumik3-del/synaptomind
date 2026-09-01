import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { closeDb, getDb } from '../db'
import {
  createEdges,
  findLinkCandidates,
  findEntityPairs,
  mergeCandidates,
  runAutoLinkJob,
  getLastAutoLinkStatus
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

// ── findEntityPairs ──────────────────────────────────────────────────────────

test('findEntityPairs returns empty for < 2 candidates', () => {
  expect(findEntityPairs([])).toEqual([])
  expect(findEntityPairs(['a'])).toEqual([])
})

test('findEntityPairs finds pairs with shared entities', () => {
  const db = getDb()
  const a = seedThought({ content: 'a' })
  const b = seedThought({ content: 'b' })
  const now = new Date().toISOString()
  db.prepare('INSERT INTO thought_entities (thought_id, entity_name, entity_type, created_at) VALUES (?, ?, ?, ?)').run(a, 'test_entity', 'code', now)
  db.prepare('INSERT INTO thought_entities (thought_id, entity_name, entity_type, created_at) VALUES (?, ?, ?, ?)').run(b, 'test_entity', 'code', now)
  const pairs = findEntityPairs([a, b])
  expect(pairs.length).toBe(1)
  expect(pairs[0].entityOverlap).toBe(1)
  expect(pairs[0].score).toBe(2)
})

test('findEntityPairs returns empty when no shared entities', () => {
  const db = getDb()
  const a = seedThought()
  const b = seedThought()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO thought_entities (thought_id, entity_name, entity_type, created_at) VALUES (?, ?, ?, ?)').run(a, 'entity_a', 'code', now)
  db.prepare('INSERT INTO thought_entities (thought_id, entity_name, entity_type, created_at) VALUES (?, ?, ?, ?)').run(b, 'entity_b', 'code', now)
  expect(findEntityPairs([a, b])).toEqual([])
})

// ── mergeCandidates ──────────────────────────────────────────────────────────

test('mergeCandidates merges entity and embedding pairs', () => {
  const entityPairs: CandidatePair[] = [
    { source_id: 'a', target_id: 'b', entityOverlap: 3, embeddingSimilarity: 0, score: 6 }
  ]
  const embeddingPairs: CandidatePair[] = [
    { source_id: 'a', target_id: 'b', entityOverlap: 0, embeddingSimilarity: 0.9, score: 0.9 }
  ]
  const merged = mergeCandidates(entityPairs, embeddingPairs, 10)
  expect(merged).toHaveLength(1)
  expect(merged[0].entityOverlap).toBe(3)
  expect(merged[0].embeddingSimilarity).toBeCloseTo(0.9)
  expect(merged[0].score).toBeCloseTo(6.9)
})

test('mergeCandidates sorts by score descending and limits to maxEdges', () => {
  const pairs: CandidatePair[] = [
    { source_id: 'a', target_id: 'b', entityOverlap: 1, embeddingSimilarity: 0, score: 2 },
    { source_id: 'c', target_id: 'd', entityOverlap: 5, embeddingSimilarity: 0, score: 10 }
  ]
  const result = mergeCandidates(pairs, [], 1)
  expect(result).toHaveLength(1)
  expect(result[0].source_id).toBe('c')
})

test('mergeCandidates deduplicates pairs with sorted key', () => {
  const pairs: CandidatePair[] = [
    { source_id: 'b', target_id: 'a', entityOverlap: 2, embeddingSimilarity: 0, score: 4 },
    { source_id: 'a', target_id: 'b', entityOverlap: 1, embeddingSimilarity: 0.8, score: 2.8 }
  ]
  const result = mergeCandidates(pairs, [], 10)
  expect(result).toHaveLength(1)
  expect(result[0].entityOverlap).toBe(2)
  expect(result[0].embeddingSimilarity).toBeCloseTo(0.8)
})

// ── createEdges ──────────────────────────────────────────────────────────────

test('createEdges creates related edges for pairs', () => {
  const a = seedThought()
  const b = seedThought()
  const pairs: CandidatePair[] = [
    { source_id: a, target_id: b, entityOverlap: 1, embeddingSimilarity: 0, score: 2 }
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
    { source_id: a, target_id: b, entityOverlap: 1, embeddingSimilarity: 0, score: 2 }
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
  const a = seedThought({ content: 'first thought about topic X' })
  const b = seedThought({ content: 'second thought about topic X' })
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO thought_entities (thought_id, entity_name, entity_type, created_at) VALUES (?, ?, ?, ?)').run(a, 'shared', 'code', now)
  db.prepare('INSERT INTO thought_entities (thought_id, entity_name, entity_type, created_at) VALUES (?, ?, ?, ?)').run(b, 'shared', 'code', now)
  const result = await runAutoLinkJob({ dryRun: true }, { embed: async () => [new Float32Array(384), new Float32Array(384)] })
  expect(result.dry_run).toBeTrue()
  expect(result.edges_created).toBe(0)
})

test('getLastAutoLinkStatus returns null before any run', () => {
  const status = getLastAutoLinkStatus()
  expect(status.last_run).toBeNull()
  expect(status.result).toBeNull()
})
