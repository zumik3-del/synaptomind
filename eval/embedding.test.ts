import { describe, expect, test } from 'bun:test'
import { deterministicEmbedding, tokenize } from './embedding'

const DEFAULT_DIMENSIONS = 384

function norm(vector: Float32Array): number {
  let sum = 0
  for (const value of vector) sum += value * value
  return Math.sqrt(sum)
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

describe('tokenize', () => {
  test('lowercases and splits on non-alphanumerics', () => {
    expect(tokenize('Hello, World!')).toEqual(['hello', 'world'])
  })

  test('drops tokens of two characters or fewer', () => {
    expect(tokenize('a an the of SQL')).toEqual(['the', 'sql'])
  })

  test('empty and punctuation-only text yield no tokens', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('--- ...')).toEqual([])
  })
})

describe('deterministicEmbedding', () => {
  test('is deterministic for the same text', () => {
    const first = deterministicEmbedding('same input text')
    const second = deterministicEmbedding('same input text')

    expect(Array.from(first)).toEqual(Array.from(second))
  })

  test('defaults to 384 dimensions and honours a custom size', () => {
    expect(deterministicEmbedding('alpha beta').length).toBe(DEFAULT_DIMENSIONS)
    expect(deterministicEmbedding('alpha beta', 16).length).toBe(16)
  })

  test('normalises the vector to unit L2 norm', () => {
    expect(norm(deterministicEmbedding('alpha beta gamma'))).toBeCloseTo(1, 6)
  })

  test('empty or stopword-only text produces an all-zero vector without NaN', () => {
    const vector = deterministicEmbedding('')
    const values = Array.from(vector)

    expect(values.every(value => value === 0)).toBe(true)
    expect(norm(vector)).toBe(0)
    expect(values.some(Number.isNaN)).toBe(false)
  })

  test('texts sharing tokens are closer than unrelated texts', () => {
    const base = deterministicEmbedding('the italian pasta recipe')
    const close = deterministicEmbedding('italian pasta recipe')
    const far = deterministicEmbedding('kubernetes cluster autoscaling')

    expect(dot(base, close)).toBeGreaterThan(dot(base, far))
  })
})
