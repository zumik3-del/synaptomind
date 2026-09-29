import { expect, test, describe } from 'bun:test'
import { normalise, jaccard } from './text-similarity'

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
