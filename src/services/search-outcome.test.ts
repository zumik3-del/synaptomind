import { describe, expect, test } from 'bun:test'
import type { SearchResult } from '../db/search'
import { keepsUnderRelevanceGate } from './search-outcome'

/**
 * Task #2178: the relevance-gate predicate, in isolation.
 *
 * The service-level behaviour (which rows the gate actually drops) lives in
 * `search.service.gate.test.ts`; here the boundary arithmetic is exact, because
 * the fixtures are hand-built instead of coming back through float32 vec0.
 */

function result(overrides: Partial<SearchResult>): SearchResult {
  return {
    thought: { id: 'x', content: '', status: 'active' } as SearchResult['thought'],
    match_source: ['embedding'],
    low_confidence: false,
    ...overrides
  }
}

describe('keepsUnderRelevanceGate', () => {
  test('threshold 0 disables the gate (the pre-#2178 fail-open set)', () => {
    expect(keepsUnderRelevanceGate(result({ relevance: 0 }), 0)).toBe(true)
    expect(keepsUnderRelevanceGate(result({ relevance: undefined }), 0)).toBe(true)
    expect(keepsUnderRelevanceGate(result({ match_source: [] }), 0)).toBe(true)
  })

  test('a negative threshold also disables the gate', () => {
    expect(keepsUnderRelevanceGate(result({ relevance: 0.1 }), -1)).toBe(true)
  })

  test('a lexical (BM25) anchor always passes, whatever its relevance', () => {
    expect(keepsUnderRelevanceGate(result({ match_source: ['bm25'], relevance: 0 }), 0.9)).toBe(true)
    expect(keepsUnderRelevanceGate(result({ match_source: ['bm25'] }), 0.9)).toBe(true)
    expect(
      keepsUnderRelevanceGate(result({ match_source: ['embedding', 'bm25'], relevance: 0 }), 0.9)
    ).toBe(true)
  })

  test('an id result always passes', () => {
    expect(keepsUnderRelevanceGate(result({ match_source: ['id'] }), 1)).toBe(true)
  })

  test('a cosine-only row is kept exactly at the threshold and above', () => {
    expect(keepsUnderRelevanceGate(result({ relevance: 0.4 }), 0.4)).toBe(true)
    expect(keepsUnderRelevanceGate(result({ relevance: 0.4000001 }), 0.4)).toBe(true)
    expect(keepsUnderRelevanceGate(result({ relevance: 1 }), 0.4)).toBe(true)
  })

  test('a cosine-only row just below the threshold is dropped', () => {
    expect(keepsUnderRelevanceGate(result({ relevance: 0.3999999 }), 0.4)).toBe(false)
    expect(keepsUnderRelevanceGate(result({ relevance: 0 }), 0.4)).toBe(false)
  })

  test('a row with no calibrated relevance counts as 0, so it is dropped', () => {
    expect(keepsUnderRelevanceGate(result({ relevance: undefined }), 0.4)).toBe(false)
  })
})
