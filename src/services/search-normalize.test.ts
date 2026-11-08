import { expect, test } from 'bun:test'
import { DEFAULT_MIN_RELEVANCE, normalizeSearchOptions } from './search-normalize.service'

test('relevance and confidence clamps preserve finite bounds and reject non-finite values', () => {
  for (const [value, expected] of [
    [NaN, 0],
    [Infinity, 0],
    [-Infinity, 0],
    [-1, 0],
    [0, 0],
    [0.5, 0.5],
    [1, 1],
    [2, 1]
  ]) {
    const result = normalizeSearchOptions({
      query: 'test',
      minRelevance: value,
      confidenceFloor: value
    })
    expect(result.minRelevance).toBe(expected)
    expect(result.confidenceFloor).toBe(expected)
  }
  expect(normalizeSearchOptions({ query: 'test' }).minRelevance).toBe(DEFAULT_MIN_RELEVANCE)
})
