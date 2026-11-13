import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../context/container'
import { closeDb } from '../db/init'
import { createTestDb, seedEdge, seedLegacyPairEdge, seedThought } from './helpers'

beforeEach(createTestDb)
afterEach(closeDb)

function indexNames(table: string): string[] {
  return (
    getDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`)
      .all(table) as {
      name: string
    }[]
  ).map(row => row.name)
}

function edgeCountBetween(a: string, b: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM edges
       WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)`
    )
    .get(a, b, b, a) as { c: number }
  return row.c
}

test('seedLegacyPairEdge models the pre-v046 shape without dropping any other index', () => {
  const before = indexNames('edges')
  expect(before).toContain('idx_edges_pair')

  const a = seedThought({ content: 'legacy a' })
  const b = seedThought({ content: 'legacy b' })
  const first = seedEdge(a, b, 'related')
  const second = seedLegacyPairEdge(b, a, 'related')

  expect(second).not.toBe(first)
  expect(edgeCountBetween(a, b)).toBe(2)

  const named = (names: string[]): string[] =>
    names.filter(name => !name.startsWith('sqlite_autoindex_')).sort()
  const after = indexNames('edges')
  expect(after).not.toContain('idx_edges_pair')
  expect(after).toEqual(expect.arrayContaining(['idx_edges_source', 'idx_edges_target']))
  expect(named(after)).toEqual(named(before).filter(name => name !== 'idx_edges_pair'))
})

test('seedLegacyPairEdge is idempotent: a second call only inserts', () => {
  const a = seedThought({ content: 'legacy a' })
  const b = seedThought({ content: 'legacy b' })
  seedEdge(a, b, 'related')

  const first = seedLegacyPairEdge(a, b, 'develops')
  const second = seedLegacyPairEdge(a, b, 'supports')

  expect(first).not.toBe(second)
  expect(edgeCountBetween(a, b)).toBe(3)
})

test('seedEdge still enforces one edge per pair on the live schema', () => {
  const a = seedThought({ content: 'live a' })
  const b = seedThought({ content: 'live b' })
  seedEdge(a, b, 'related')

  expect(() => seedEdge(b, a, 'develops')).toThrow('UNIQUE constraint failed')
})
