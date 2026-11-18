import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb, getDb } from '../db'
import { config } from '../config'
import { promoteThoughtToPrimer } from '../db/primers'
import {
  extractResultIds,
  postProcessSearchResults,
  prependPrimerResults,
  updatePrimerHits
} from './search_postprocess.service'
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
  expect(reordered).toHaveLength(2)
  expect((reordered[0] as SearchResult).thought.id).toBe('a')
})

test('prependPrimerResults preserves low_confidence on a hoisted primer', () => {
  const weakPrimer = makeSearchResult('weak-primer', {
    low_confidence: true,
    match_source: ['embedding'],
    similarity: 0.2
  })
  const strong = makeSearchResult('strong', {
    low_confidence: false,
    match_source: ['bm25'],
    similarity: 0
  })
  const reordered = prependPrimerResults([strong, weakPrimer], ['weak-primer']) as SearchResult[]
  expect(reordered[0].thought.id).toBe('weak-primer')
  expect(reordered[0].low_confidence).toBe(true)
  expect(reordered).toHaveLength(2)
})

test('updatePrimerHits increments hit counts', () => {
  const id = seedThought()
  const results = [makeSearchResult(id)]
  updatePrimerHits(results)
  const db = getDb()
  const row = db
    .prepare('SELECT hit_count FROM thought_importance WHERE thought_id = ?')
    .get(id) as { hit_count: number }
  expect(row.hit_count).toBe(1)
})

test('updatePrimerHits handles empty results', () => {
  expect(() => updatePrimerHits([])).not.toThrow()
})

function leaveLegacyProfileFlag(result: SearchResult): SearchResult {
  ;(result.thought as unknown as Record<string, unknown>).is_profile = 1
  return result
}

test('the retired profile flag does not reorder results', () => {
  const plain = makeSearchResult('plain')
  const legacyProfile = leaveLegacyProfileFlag(makeSearchResult('legacy-profile'))

  const processed = postProcessSearchResults([plain, legacyProfile], { showPrimers: false })

  expect(processed.map(r => (r as SearchResult).thought.id)).toEqual(['plain', 'legacy-profile'])
})

test('the retired profile flag leaves primer hoisting as the only reorder', () => {
  const flagged = leaveLegacyProfileFlag(makeSearchResult('legacy-profile'))
  const primer = seedThought({ content: 'primer thought', status: 'active' })
  getDb()
    .prepare('INSERT INTO primers (id, thought_id, hit_count, created_at) VALUES (?, ?, 5, ?)')
    .run(crypto.randomUUID(), primer, new Date().toISOString())

  const processed = postProcessSearchResults([flagged, makeSearchResult(primer)], {
    showPrimers: true
  })

  expect(processed.map(r => (r as SearchResult).thought.id)).toEqual([primer, flagged.thought.id])
})

function hitThought(thoughtId: string, times: number): void {
  const results = [makeSearchResult(thoughtId)]
  for (let i = 0; i < times; i++) updatePrimerHits(results)
}

function primerRow(thoughtId: string): { hit_count: number } | null {
  return getDb().prepare('SELECT hit_count FROM primers WHERE thought_id = ?').get(thoughtId) as {
    hit_count: number
  } | null
}

test('updatePrimerHits does not promote a thought below the configured threshold', () => {
  const original = config.primer.promoteThreshold
  config.primer.promoteThreshold = 15
  try {
    const id = seedThought({ content: 'below the promotion threshold' })
    hitThought(id, 7)
    expect(primerRow(id)).toBeNull()
  } finally {
    config.primer.promoteThreshold = original
  }
})

test('updatePrimerHits promotes a thought once it reaches the configured threshold', () => {
  const original = config.primer.promoteThreshold
  config.primer.promoteThreshold = 15
  try {
    const id = seedThought({ content: 'reaching the promotion threshold' })
    hitThought(id, 15)
    expect(primerRow(id)?.hit_count).toBe(15)
  } finally {
    config.primer.promoteThreshold = original
  }
})

test('updatePrimerHits reads the threshold from the config, not from a literal', () => {
  const original = config.primer.promoteThreshold
  try {
    config.primer.promoteThreshold = 99
    const quiet = seedThought({ content: 'quiet thought' })
    hitThought(quiet, 5)
    expect(primerRow(quiet)).toBeNull()

    config.primer.promoteThreshold = 2
    const loud = seedThought({ content: 'loud thought' })
    hitThought(loud, 2)
    expect(primerRow(loud)).not.toBeNull()
  } finally {
    config.primer.promoteThreshold = original
  }
})

test('prependPrimerResults keeps a group that carries no items at all', () => {
  const empty = makeGroupedResult('c1', [])
  delete (empty as { items?: unknown }).items
  const primer = makeSearchResult('p1')

  const reordered = prependPrimerResults([empty, primer], ['p1']) as Array<
    SearchResult | GroupedResult
  >

  expect(reordered).toHaveLength(2)
  expect((reordered[0] as SearchResult).thought.id).toBe('p1')
  expect(reordered[1]).toBe(empty)
})

test('postProcessSearchResults leaves the primer hoisting alone when showPrimers is off', () => {
  const primerId = seedThought({ content: 'primer thought' })
  promoteThoughtToPrimer(getDb(), primerId, config.primer.promoteThreshold)
  const results = [makeSearchResult('other'), makeSearchResult(primerId)]

  const processed = postProcessSearchResults(results, { showPrimers: false }) as SearchResult[]

  expect(processed.map(result => result.thought.id)).toEqual(['other', primerId])
})
