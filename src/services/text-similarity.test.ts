import { expect, test, describe } from 'bun:test'
import { DEFAULTS } from '../config'
import { calibrateRelevance, normalise, jaccard } from './text-similarity'

describe('normalise', () => {
  test('lowercases', () => {
    expect(normalise('HELLO World')).toBe('hello world')
  })

  test('collapses runs of whitespace into a single space', () => {
    expect(normalise('a   b\tc\nd')).toBe('a b c d')
  })

  test('trims leading/trailing whitespace', () => {
    expect(normalise('  hello  ')).toBe('hello')
  })

  test('empty string stays empty', () => {
    expect(normalise('')).toBe('')
  })

  test('unicode punctuation is preserved', () => {
    expect(normalise('café résumé')).toBe('café résumé')
  })
})

describe('jaccard', () => {
  test('empty vs empty returns 1 (perfect similarity)', () => {
    expect(jaccard('', '')).toBe(1)
  })

  test('empty vs non-empty returns 0', () => {
    expect(jaccard('', 'hello')).toBe(0)
    expect(jaccard('hello', '')).toBe(0)
  })

  test('identical words return 1', () => {
    expect(jaccard('hello world', 'hello world')).toBe(1)
  })

  test('disjoint word sets return 0', () => {
    expect(jaccard('a b c', 'x y z')).toBe(0)
  })

  test('partial overlap is proportional to union', () => {
    // {a,b,c} ∩ {b,c,d} = {b,c}, union = {a,b,c,d} → 2/4 = 0.5
    expect(jaccard('a b c', 'b c d')).toBeCloseTo(0.5, 5)
  })

  test('case-sensitive; callers normalise first', () => {
    // jaccard operates on raw input; normalise() handles lowercasing.
    expect(jaccard('Hello hello', 'hello HELLO')).toBeCloseTo(1 / 3, 5)
    expect(jaccard('a b c', 'a b c')).toBe(1)
  })

  test('duplicates within a string are deduplicated via Set', () => {
    // {a,a,b} vs {a,b,b} → overlap {a,b}, union {a,b} → 1
    expect(jaccard('a a b', 'a b b')).toBe(1)
  })

  test('punctuation attached to words counts as part of the word', () => {
    expect(jaccard('hello,', 'hello')).toBe(0)
  })
})

// ── calibrateRelevance (task #2178) ──────────────────────────────────────────
//
// The raw e5-small cosine scale is compressed (unrelated pairs sit around 0.76),
// so a raw similarity cannot be thresholded. `calibrateRelevance` maps the
// measured band [unrelatedFloor, confidenceFloor] onto [0, 1]. These cases pin
// the exact fixture values the default gate is set from; the repo defaults are
// read from `DEFAULTS` so the fixture cannot silently drift from config.
describe('calibrateRelevance', () => {
  const FLOOR = 0.8
  const CEIL = 0.9

  test('the repo defaults are the measured pair (0.8 → 0.9)', () => {
    expect(DEFAULTS.search.confidence.unrelatedFloor).toBe(0.8)
    expect(DEFAULTS.search.confidence.vectorFloor).toBe(0.9)
  })

  test('the unrelated floor is the zero point', () => {
    expect(calibrateRelevance(FLOOR, FLOOR, CEIL)).toBe(0)
  })

  test('the confidence floor is the ceiling', () => {
    expect(calibrateRelevance(CEIL, FLOOR, CEIL)).toBe(1)
  })

  test('the midpoint of the band is 0.5', () => {
    expect(calibrateRelevance(0.85, FLOOR, CEIL)).toBeCloseTo(0.5, 10)
  })

  test('a quarter into the band is 0.25', () => {
    expect(calibrateRelevance(0.825, FLOOR, CEIL)).toBeCloseTo(0.25, 10)
  })

  test('below the unrelated floor clamps to 0, never negative', () => {
    expect(calibrateRelevance(0.7, FLOOR, CEIL)).toBe(0)
    expect(calibrateRelevance(0, FLOOR, CEIL)).toBe(0)
  })

  test('above the confidence floor clamps to 1, never above one', () => {
    expect(calibrateRelevance(0.95, FLOOR, CEIL)).toBe(1)
    expect(calibrateRelevance(1, FLOOR, CEIL)).toBe(1)
  })

  test('a degenerate band steps at the confidence floor instead of dividing by zero', () => {
    // `span <= 0` (misconfigured override): everything at/above the floor is a
    // strong match (1), everything below it is unrelated (0). No NaN escapes.
    expect(calibrateRelevance(0.9, 0.9, 0.9)).toBe(1)
    expect(calibrateRelevance(0.95, 0.9, 0.9)).toBe(1)
    expect(calibrateRelevance(0.85, 0.9, 0.9)).toBe(0)
    expect(calibrateRelevance(0.5, 0.9, 0.8)).toBe(0)
  })

  test('a non-finite similarity is 0, never NaN', () => {
    // `clamp01` maps every non-finite input to 0 (NaN and ±Infinity alike), so
    // no NaN can leak into a score or into the gate comparison. A stored cosine
    // similarity is always finite in practice; this only guards the arithmetic.
    expect(calibrateRelevance(Number.NaN, FLOOR, CEIL)).toBe(0)
    expect(calibrateRelevance(Number.POSITIVE_INFINITY, FLOOR, CEIL)).toBe(0)
  })

  test('calibration is monotone across the band', () => {
    const samples = [0.79, 0.8, 0.82, 0.85, 0.88, 0.9, 0.92]
    const values = samples.map(s => calibrateRelevance(s, FLOOR, CEIL))
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1])
  })
})
