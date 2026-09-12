import { describe, expect, test } from 'bun:test'
import { averageMetrics, computeQueryMetrics } from './metrics'
import type { QueryMetrics } from './types'

describe('computeQueryMetrics', () => {
  test('perfect retrieval scores every metric at 1', () => {
    const metrics = computeQueryMetrics(['a', 'b'], ['a', 'b'])

    expect(metrics.recall).toBe(1)
    expect(metrics.precision).toBe(1)
    expect(metrics.mrr).toBe(1)
    expect(metrics.hit).toBe(1)
    expect(metrics.retrieved).toEqual(['a', 'b'])
  })

  test('recall divides hits by the number of relevant thoughts', () => {
    const metrics = computeQueryMetrics(['a', 'x', 'y'], ['a', 'b'])

    expect(metrics.recall).toBe(0.5)
    expect(metrics.hit).toBe(1)
  })

  test('precision divides hits by the number of retrieved thoughts', () => {
    const metrics = computeQueryMetrics(['a', 'x', 'y', 'z'], ['a'])

    expect(metrics.precision).toBe(0.25)
  })

  test('MRR is the reciprocal rank of the first relevant thought', () => {
    expect(computeQueryMetrics(['x', 'a', 'b'], ['a', 'b']).mrr).toBe(0.5)
    expect(computeQueryMetrics(['x', 'y', 'z', 'a'], ['a']).mrr).toBe(0.25)
  })

  test('no relevant retrieved yields zero recall, precision, MRR and hit', () => {
    const metrics = computeQueryMetrics(['x', 'y'], ['a'])

    expect(metrics.recall).toBe(0)
    expect(metrics.precision).toBe(0)
    expect(metrics.mrr).toBe(0)
    expect(metrics.hit).toBe(0)
  })

  test('duplicate retrieved ids are de-duplicated before scoring', () => {
    const metrics = computeQueryMetrics(['a', 'a', 'x'], ['a'])

    expect(metrics.retrieved).toEqual(['a', 'x'])
    expect(metrics.precision).toBe(0.5)
    expect(metrics.mrr).toBe(1)
  })

  test('empty retrieved list is all zeros and not NaN', () => {
    const metrics = computeQueryMetrics([], ['a'])

    expect(metrics.recall).toBe(0)
    expect(metrics.precision).toBe(0)
    expect(metrics.mrr).toBe(0)
    expect(metrics.hit).toBe(0)
    expect(Number.isNaN(metrics.recall)).toBe(false)
  })

  test('empty relevant list is all zeros and not NaN', () => {
    const metrics = computeQueryMetrics(['a', 'b'], [])

    expect(metrics.recall).toBe(0)
    expect(metrics.precision).toBe(0)
    expect(metrics.mrr).toBe(0)
    expect(metrics.hit).toBe(0)
    expect(Number.isNaN(metrics.precision)).toBe(false)
  })

  test('check errors are carried through untouched', () => {
    const metrics = computeQueryMetrics(['a'], ['a'], ['boom'])

    expect(metrics.checkErrors).toEqual(['boom'])
  })
})

describe('averageMetrics', () => {
  test('empty input aggregates to zeros with queries 0', () => {
    expect(averageMetrics([])).toEqual({
      recall: 0,
      precision: 0,
      mrr: 0,
      hitRate: 0,
      queries: 0
    })
  })

  test('averages each metric and records the query count', () => {
    const a: QueryMetrics = {
      recall: 1,
      precision: 0.5,
      mrr: 1,
      hit: 1,
      retrieved: [],
      checkErrors: []
    }
    const b: QueryMetrics = {
      recall: 0,
      precision: 0.25,
      mrr: 0.5,
      hit: 0,
      retrieved: [],
      checkErrors: []
    }

    expect(averageMetrics([a, b])).toEqual({
      recall: 0.5,
      precision: 0.375,
      mrr: 0.75,
      hitRate: 0.5,
      queries: 2
    })
  })
})
