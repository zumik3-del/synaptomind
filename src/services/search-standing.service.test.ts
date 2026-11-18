import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../context/container'
import { closeDb } from '../db/init'
import type { SearchResult } from '../db/search'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { applyGraphStanding, orderByStanding } from './search-standing.service'

beforeEach(createTestDb)
afterEach(closeDb)

function result(id: string, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    thought: {
      id,
      content: `content ${id}`,
      status: 'active',
      tags: [],
      source: null,
      project_id: 'default',
      is_cluster: 0,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z'
    },
    match_source: ['embedding'],
    low_confidence: false,
    ...overrides
  } as SearchResult
}

test('no results and both modes off return the input untouched', () => {
  expect(applyGraphStanding([], { supersessionMode: 'flag' }, getDb())).toEqual([])

  const results = [result('a')]
  expect(
    applyGraphStanding(results, { supersessionMode: 'off', contradictionMode: 'off' }, getDb())
  ).toBe(results)
})

test('a live thought is marked current and its replacement link is exposed', () => {
  const stale = seedThought({ content: 'stale claim' })
  const replacement = seedThought({ content: 'replacement claim' })
  seedEdge(replacement, stale, 'replaces')

  const [annotated] = applyGraphStanding([result(stale)], { supersessionMode: 'flag' }, getDb())

  expect(annotated.standing).toBe('superseded')
  expect(annotated.superseded_by).toEqual([replacement])
  expect(annotated.contradicted_by).toBeUndefined()
})

test('a contradicted thought is second in the standing order, superseded last', () => {
  const current = seedThought({ content: 'current' })
  const contradicted = seedThought({ content: 'contested' })
  const superseded = seedThought({ content: 'outdated' })
  const other = seedThought({ content: 'the other side' })
  const newer = seedThought({ content: 'newer version' })
  seedEdge(other, contradicted, 'contradicts')
  seedEdge(newer, superseded, 'replaces')

  const annotated = applyGraphStanding(
    [result(superseded), result(contradicted), result(current)],
    { supersessionMode: 'flag', contradictionMode: 'flag' },
    getDb()
  )

  expect(annotated.map(item => [item.thought.id, item.standing])).toEqual([
    [current, 'current'],
    [contradicted, 'contradicted'],
    [superseded, 'superseded']
  ])
  expect(annotated[1].contradicted_by).toEqual([other])
})

test('flags are independent: a mode turned off drops that annotation but keeps the standing', () => {
  const superseded = seedThought({ content: 'outdated' })
  const newer = seedThought({ content: 'newer' })
  const contradicted = seedThought({ content: 'contested' })
  const other = seedThought({ content: 'other side' })
  seedEdge(newer, superseded, 'replaces')
  seedEdge(other, contradicted, 'contradicts')

  const noContradiction = applyGraphStanding(
    [result(contradicted)],
    { supersessionMode: 'flag', contradictionMode: 'off' },
    getDb()
  )
  const noSupersession = applyGraphStanding(
    [result(superseded)],
    { supersessionMode: 'off', contradictionMode: 'flag' },
    getDb()
  )

  expect(noContradiction[0].standing).toBe('current')
  expect(noContradiction[0].contradicted_by).toBeUndefined()
  expect(noSupersession[0].standing).toBe('current')
  expect(noSupersession[0].superseded_by).toBeUndefined()
})

test('suppress mode drops a superseded thought from the answer entirely', () => {
  const superseded = seedThought({ content: 'outdated' })
  const current = seedThought({ content: 'current' })
  seedEdge(seedThought({ content: 'newer' }), superseded, 'replaces')

  const annotated = applyGraphStanding(
    [result(superseded), result(current)],
    { supersessionMode: 'suppress' },
    getDb()
  )

  expect(annotated.map(item => item.thought.id)).toEqual([current])
})

test('suppress mode keeps a contradicted thought, which is a live disagreement', () => {
  const contradicted = seedThought({ content: 'contested' })
  seedEdge(seedThought({ content: 'other side' }), contradicted, 'contradicts')

  const annotated = applyGraphStanding(
    [result(contradicted)],
    { supersessionMode: 'suppress' },
    getDb()
  )

  expect(annotated.map(item => item.standing)).toEqual(['contradicted'])
})

test('ordering is stable for equal standing and defaults a missing one to current', () => {
  const first = result('a')
  const second = result('b')

  expect(orderByStanding([first, second]).map(item => item.thought.id)).toEqual(['a', 'b'])
  expect(
    orderByStanding([{ ...first, standing: 'superseded' }, second]).map(item => item.thought.id)
  ).toEqual(['b', 'a'])
})
