import { expect, test } from 'bun:test'
import { config } from '../config'
import { DEFAULT_MIN_RELEVANCE, normalizeSearchOptions } from './search-normalize.service'

test('relevance clamps preserve finite bounds and reject non-finite values', () => {
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
    const result = normalizeSearchOptions({ query: 'test', minRelevance: value })
    expect(result.minRelevance).toBe(expected)
  }
  expect(normalizeSearchOptions({ query: 'test' }).minRelevance).toBe(DEFAULT_MIN_RELEVANCE)
})

test('confidence floors are not clamped: config values and caller values pass through', () => {
  const defaults = normalizeSearchOptions({ query: 'test' })
  expect(defaults.confidenceFloor).toBe(config.search.confidence.vectorFloor)
  expect(defaults.unrelatedFloor).toBe(config.search.confidence.unrelatedFloor)

  expect(normalizeSearchOptions({ query: 'test', confidenceFloor: 5 }).confidenceFloor).toBe(5)
  expect(normalizeSearchOptions({ query: 'test', confidenceFloor: -0.5 }).confidenceFloor).toBe(
    -0.5
  )
})
