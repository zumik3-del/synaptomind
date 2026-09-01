import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb, getDb } from '../db'
import { extractResultIds, prependPrimerResults, prependProfileResults, updatePrimerHits } from './search_postprocess.service'
import type { SearchResult } from '../db/search'
import type { GroupedResult } from './search.service'

function makeSearchResult(thoughtId: string, overrides?: Partial<SearchResult>): SearchResult {
  return {
    thought: {
      id: thoughtId,
      content: `content for ${thoughtId}`,
      status: 'active',
      tags: [],
      source: null,
      project_id: 'default',
      project_name: 'Default',
      is_cluster: 0,
      is_profile: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    distance: 0.5,
    similarity: 0.8,
    ...overrides
  } as SearchResult
}

function makeGroupedResult(clusterId: string, itemIds: string[]): GroupedResult {
  return {
    cluster: {
      id: clusterId,
      content: `cluster ${clusterId}`,
      status: 'active',
      tags: [],
      source: null,
      project_id: 'default',
      project_name: 'Default',
      is_cluster: 1,
      is_profile: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    items: itemIds.map(id => makeSearchResult(id)),
    size: itemIds.length,
    min_distance: 0.3
  } as GroupedResult
}

beforeEach(createTestDb)
afterEach(closeDb)

// ── extractResultIds ─────────────────────────────────────────────────────────

test('extractResultIds extracts ids from flat results', () => {
  const results = [makeSearchResult('a'), makeSearchResult('b')]
  expect(extractResultIds(results)).toEqual(['a', 'b'])
})

test('extractResultIds extracts ids from grouped results', () => {
  const results = [makeGroupedResult('cluster-1', ['a', 'b'])]
  expect(extractResultIds(results)).toEqual(['a', 'b'])
})

test('extractResultIds handles mixed flat and grouped', () => {
  const results = [makeSearchResult('x'), makeGroupedResult('c', ['a', 'b'])]
  expect(extractResultIds(results)).toEqual(['x', 'a', 'b'])
})

test('extractResultIds returns empty for empty input', () => {
  expect(extractResultIds([])).toEqual([])
})

// ── prependPrimerResults ─────────────────────────────────────────────────────

test('prependPrimerResults hoists primers to front', () => {
  const results = [makeSearchResult('a'), makeSearchResult('b'), makeSearchResult('c')]
  const reordered = prependPrimerResults(results, ['b'])
  expect((reordered[0] as SearchResult).thought.id).toBe('b')
  expect(reordered).toHaveLength(3)
})

test('prependPrimerResults does nothing when no primers in results', () => {
  const results = [makeSearchResult('a'), makeSearchResult('b')]
  const reordered = prependPrimerResults(results, ['z'])
  expect(reordered).toEqual(results)
})

test('prependPrimerResults preserves group structure when primer is in group', () => {
  const results = [makeGroupedResult('c1', ['a', 'b'])]
  const reordered = prependPrimerResults(results, ['a'])
  // Primer 'a' is extracted from group, group still has 'b'
  expect(reordered).toHaveLength(2)
  expect((reordered[0] as SearchResult).thought.id).toBe('a')
})

// ── prependProfileResults ────────────────────────────────────────────────────

test('prependProfileResults hoists profile thoughts for @profile query', () => {
  const a = makeSearchResult('a')
  const p = makeSearchResult('p')
  p.thought.is_profile = 1
  const results = [a, p]
  const reordered = prependProfileResults(results, '@profile stuff')
  expect((reordered[0] as SearchResult).thought.id).toBe('p')
})

test('prependProfileResults does nothing without @profile in query', () => {
  const results = [makeSearchResult('a'), makeSearchResult('b')]
  const reordered = prependProfileResults(results, 'normal query')
  expect(reordered).toEqual(results)
})

test('prependProfileResults does nothing when no profile thoughts', () => {
  const results = [makeSearchResult('a')]
  const reordered = prependProfileResults(results, '@profile')
  expect(reordered).toEqual(results)
})

// ── updatePrimerHits ─────────────────────────────────────────────────────────

test('updatePrimerHits increments hit counts', () => {
  const id = seedThought()
  const results = [makeSearchResult(id)]
  updatePrimerHits(results)
  const db = getDb()
  const row = db.prepare('SELECT hit_count FROM thought_importance WHERE thought_id = ?').get(id) as { hit_count: number }
  expect(row.hit_count).toBe(1)
})

test('updatePrimerHits handles empty results', () => {
  expect(() => updatePrimerHits([])).not.toThrow()
})
