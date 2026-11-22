import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../db'
import { closeDb } from '../db/init'
import {
  FALLBACK_RECENCY_HALF_LIFE_DAYS,
  fetchThoughtsByIds,
  type SearchRecencyContext
} from '../db/search-hydrate'
import { createTestDb, seedThought } from '../test/helpers'
import { MS_PER_DAY } from '../utils'
import { normalizeSearchOptions, type NormalizedSearchOptions } from './search-normalize.service'

const NORMALIZE_SOURCE = join(import.meta.dir, 'search-normalize.service.ts')

function normalize(recencyHalfLifeDays?: number): NormalizedSearchOptions {
  return normalizeSearchOptions({
    query: 'recency default',
    ...(recencyHalfLifeDays === undefined ? {} : { recencyHalfLifeDays })
  })
}

describe('the recency half-life default lives in one place', () => {
  test('an absent half-life takes the db-layer constant', () => {
    expect(normalize().recencyHalfLifeDays).toBe(FALLBACK_RECENCY_HALF_LIFE_DAYS)
  })

  test('an invalid half-life takes the same constant', () => {
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalize(invalid).recencyHalfLifeDays).toBe(FALLBACK_RECENCY_HALF_LIFE_DAYS)
    }
  })

  test('a valid half-life is kept inside the declared bounds', () => {
    expect(normalize(14).recencyHalfLifeDays).toBe(14)
    expect(normalize(0.5).recencyHalfLifeDays).toBe(1)
    expect(normalize(10_000).recencyHalfLifeDays).toBe(3650)
  })

  test('search-normalize declares no second half-life literal and imports the db-layer one', () => {
    const source = readFileSync(NORMALIZE_SOURCE, 'utf8')
    const declared = [...source.matchAll(/\b(\w*HALF_LIFE_DAYS)\s*=/g)]
      .map(match => match[1])
      .sort()

    expect(source).toContain('FALLBACK_RECENCY_HALF_LIFE_DAYS')
    expect(source).toContain("from '../db/search-hydrate'")
    expect(declared).toEqual(['MAX_RECENCY_HALF_LIFE_DAYS', 'MIN_RECENCY_HALF_LIFE_DAYS'])
  })
})

describe('the default the service clamps to is the decay the db layer applies', () => {
  beforeEach(createTestDb)
  afterEach(closeDb)

  test('a thought one default half-life old scores 0.5 under the normalized value', () => {
    const nowMs = Date.parse('2026-06-01T00:00:00.000Z')
    const id = seedThought({ content: 'one half-life old', created_at: '2025-05-02' })
    getDb()
      .prepare('UPDATE thoughts SET created_at = ? WHERE id = ?')
      .run(new Date(nowMs - FALLBACK_RECENCY_HALF_LIFE_DAYS * MS_PER_DAY).toISOString(), id)

    const recency: SearchRecencyContext = {
      rrfMax: 0,
      recencyActive: true,
      recencyWeight: 0.5,
      recencyHalfLifeDays: normalize().recencyHalfLifeDays,
      nowMs
    }
    const [result] = fetchThoughtsByIds(
      getDb(),
      [id],
      { embedding: new Float32Array(0) },
      {
        vecSimById: new Map<string, number>(),
        bm25ScoreById: new Map<string, number>(),
        rrfScoreById: new Map<string, number>(),
        confidenceFloor: 0.5
      },
      recency
    )

    expect(result.recency_score).toBeCloseTo(0.5, 10)
    expect(result.final_score).toBeCloseTo(0.25, 10)
  })
})
