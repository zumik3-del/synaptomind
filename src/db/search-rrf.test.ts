import { expect, test } from 'bun:test'
import { RRF_K, rrfMerge } from './search-rrf'

test('the fusion constant is the published 60', () => {
  expect(RRF_K).toBe(60)
})

test('a single list keeps its order and scores 1/(k+rank)', () => {
  expect(rrfMerge([['a', 'b', 'c']])).toEqual([
    { id: 'a', score: 1 / 61 },
    { id: 'b', score: 1 / 62 },
    { id: 'c', score: 1 / 63 }
  ])
})

test('an id found by both legs outranks an id only one leg returned', () => {
  const merged = rrfMerge([
    ['shared', 'vec-only'],
    ['bm25-only', 'shared']
  ])

  expect(merged[0].id).toBe('shared')
  expect(merged.find(m => m.id === 'shared')?.score).toBeCloseTo(1 / 61 + 1 / 62, 12)
  expect(merged.map(m => m.id)).toContain('vec-only')
  expect(merged.map(m => m.id)).toContain('bm25-only')
})

test('a repeated id accumulates its contributions instead of appearing twice', () => {
  const merged = rrfMerge([['a', 'a'], ['a']])

  expect(merged).toHaveLength(1)
  expect(merged[0].score).toBeCloseTo(1 / 61 + 1 / 62 + 1 / 61, 12)
})

test('empty lists fuse to nothing', () => {
  expect(rrfMerge([])).toEqual([])
  expect(rrfMerge([[], []])).toEqual([])
})
