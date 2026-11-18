import { expect, test } from 'bun:test'
import { ValidationError } from '../errors'
import {
  buildSearchOptions,
  parseContradictionMode,
  parseOptionalNumber,
  parseSupersessionMode
} from './search-options.service'

test('an absent or empty mode falls back to the documented default', () => {
  expect(parseSupersessionMode(undefined)).toBe('suppress')
  expect(parseSupersessionMode('')).toBe('suppress')
  expect(parseContradictionMode(undefined)).toBe('flag')
  expect(parseContradictionMode('')).toBe('flag')
})

test('every advertised mode round-trips', () => {
  for (const mode of ['off', 'flag', 'suppress'] as const) {
    expect(parseSupersessionMode(mode)).toBe(mode)
  }
  for (const mode of ['off', 'flag'] as const) {
    expect(parseContradictionMode(mode)).toBe(mode)
  }
})

test('an unadvertised mode is refused with the accepted list', () => {
  expect(() => parseSupersessionMode('nope')).toThrow(ValidationError)
  expect(() => parseSupersessionMode('nope')).toThrow(
    "invalid supersession_mode 'nope'; expected off|flag|suppress"
  )
  // 'suppress' is a supersession-only value: a contradiction mode must not accept it.
  expect(() => parseContradictionMode('suppress')).toThrow(
    "invalid contradiction_mode 'suppress'; expected off|flag"
  )
})

test('an absent or empty optional number is undefined rather than zero', () => {
  expect(parseOptionalNumber(undefined, 'min_importance')).toBeUndefined()
  expect(parseOptionalNumber('', 'min_importance')).toBeUndefined()
})

test('an optional number parses the decimal forms the wire accepts', () => {
  expect(parseOptionalNumber('0', 'min_importance')).toBe(0)
  expect(parseOptionalNumber('0.35', 'min_importance')).toBe(0.35)
  expect(parseOptionalNumber('-1', 'recency_weight')).toBe(-1)
  // parseFloat stops at the second dot, so a malformed tail is ignored rather than refused.
  expect(parseOptionalNumber('0.1.2', 'min_importance')).toBe(0.1)
})

test('an optional number rejects text and the non-finite spellings', () => {
  for (const raw of ['abc', 'Infinity', 'NaN', '-Infinity']) {
    expect(() => parseOptionalNumber(raw, 'min_relevance')).toThrow(ValidationError)
    expect(() => parseOptionalNumber(raw, 'min_relevance')).toThrow(
      `invalid min_relevance '${raw}'; expected a number`
    )
  }
})

test('buildSearchOptions defaults the status to active and carries every caller value through', () => {
  expect(buildSearchOptions({ query: 'q', topK: 5 }).statusFilter).toBe('active')

  const options = buildSearchOptions({
    query: 'q',
    topK: 7,
    status: 'all',
    projectFilter: 'proj-1',
    tagFilter: 'alpha',
    clusterFilter: 'only',
    minImportance: 0.2,
    hybrid: false,
    supersessionMode: 'flag',
    contradictionMode: 'off',
    recencyWeight: 0.4,
    recencyHalfLifeDays: 14,
    minRelevance: 0.3
  })

  expect(options).toEqual({
    query: 'q',
    topK: 7,
    statusFilter: 'all',
    projectFilter: 'proj-1',
    tagFilter: 'alpha',
    clusterFilter: 'only',
    minImportance: 0.2,
    hybrid: false,
    supersessionMode: 'flag',
    contradictionMode: 'off',
    recencyWeight: 0.4,
    recencyHalfLifeDays: 14,
    minRelevance: 0.3
  })
})
