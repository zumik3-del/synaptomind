import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { getDb } from '../db'
import { closeDb } from '../db/init'
import { getThoughtRow } from '../db/thoughts'
import { ValidationError } from '../errors'
import { transferEdgesFromSource, validateMergePreconditions } from './merge'

beforeEach(createTestDb)
afterEach(closeDb)

function edgeExists(db: Database, sourceId: string, targetId: string, type: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM edges WHERE source_id = ? AND target_id = ? AND type = ?`)
    .get(sourceId, targetId, type)
  return row !== null && row !== undefined
}

function edgeCountBetween(db: Database, sourceId: string, targetId: string, type: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS cnt FROM edges WHERE source_id = ? AND target_id = ? AND type = ?`)
    .get(sourceId, targetId, type) as { cnt: number }
  return row.cnt
}

test('remaps outgoing edges source→X to target→X and returns the count', () => {
  const db = getDb()
  const source = seedThought({ content: 'source thought' })
  const target = seedThought({ content: 'target thought' })
  const x1 = seedThought({ content: 'neighbor x1' })
  const x2 = seedThought({ content: 'neighbor x2' })
  seedEdge(source, x1, 'develops')
  seedEdge(source, x2, 'related')

  const transferred = transferEdgesFromSource(db, source, target)

  expect(transferred).toBe(2)
  expect(edgeExists(db, target, x1, 'develops')).toBe(true)
  expect(edgeExists(db, target, x2, 'related')).toBe(true)
})

test('remaps incoming edges X→source to X→target', () => {
  const db = getDb()
  const source = seedThought({ content: 'source thought' })
  const target = seedThought({ content: 'target thought' })
  const x = seedThought({ content: 'upstream x' })
  seedEdge(x, source, 'develops')

  const transferred = transferEdgesFromSource(db, source, target)

  expect(transferred).toBe(1)
  expect(edgeExists(db, x, target, 'develops')).toBe(true)
})

test('collapses the pair edge between source and target without creating a self-loop', () => {
  const db = getDb()
  const source = seedThought({ content: 'source thought' })
  const target = seedThought({ content: 'target thought' })
  seedEdge(source, target, 'related')
  seedEdge(target, source, 'develops')

  const transferred = transferEdgesFromSource(db, source, target)

  expect(transferred).toBe(0)
  // both pair edges are deleted, neither recreated as target→target
  expect(edgeCountBetween(db, target, target, 'related')).toBe(0)
  expect(edgeCountBetween(db, target, target, 'develops')).toBe(0)
  expect(edgeExists(db, source, target, 'related')).toBe(false)
  expect(edgeExists(db, target, source, 'develops')).toBe(false)
})

test('skips a duplicate edge on the target and continues the merge', () => {
  const db = getDb()
  const source = seedThought({ content: 'source thought' })
  const target = seedThought({ content: 'target thought' })
  const x = seedThought({ content: 'shared neighbor' })
  const y = seedThought({ content: 'other neighbor' })
  // both source→x and target→x exist: remapping source→x would duplicate
  seedEdge(source, x, 'develops')
  seedEdge(target, x, 'develops')
  seedEdge(source, y, 'develops')

  const transferred = transferEdgesFromSource(db, source, target)

  // duplicate skipped (EdgeAlreadyExistsError), the other edge still transfers
  expect(transferred).toBe(1)
  expect(edgeCountBetween(db, target, x, 'develops')).toBe(1)
  expect(edgeExists(db, target, y, 'develops')).toBe(true)
})

test('skips a cluster edge whose remapped source is not a cluster thought', () => {
  const db = getDb()
  const source = seedThought({ content: 'source cluster', is_cluster: 1 })
  const target = seedThought({ content: 'regular target' })
  const member = seedThought({ content: 'cluster member' })
  seedEdge(source, member, 'cluster')

  const transferred = transferEdgesFromSource(db, source, target)

  // revalidation fails → continue WITHOUT delete: edge stays as-is, not counted
  expect(transferred).toBe(0)
  expect(edgeExists(db, source, member, 'cluster')).toBe(true)
  expect(edgeExists(db, target, member, 'cluster')).toBe(false)
})

test('skips a cluster edge when both remapped endpoints are clusters', () => {
  const db = getDb()
  const source = seedThought({ content: 'source cluster', is_cluster: 1 })
  const target = seedThought({ content: 'target cluster', is_cluster: 1 })
  const otherCluster = seedThought({ content: 'other cluster', is_cluster: 1 })
  seedEdge(source, otherCluster, 'cluster')

  const transferred = transferEdgesFromSource(db, source, target)

  expect(transferred).toBe(0)
  expect(edgeExists(db, source, otherCluster, 'cluster')).toBe(true)
  expect(edgeExists(db, target, otherCluster, 'cluster')).toBe(false)
})

test('transfers valid cluster edges when merging a cluster into a cluster', () => {
  const db = getDb()
  const source = seedThought({ content: 'source cluster', is_cluster: 1 })
  const target = seedThought({ content: 'target cluster', is_cluster: 1 })
  const member = seedThought({ content: 'cluster member' })
  seedEdge(source, member, 'cluster')

  const transferred = transferEdgesFromSource(db, source, target)

  expect(transferred).toBe(1)
  expect(edgeExists(db, target, member, 'cluster')).toBe(true)
})

test('validateMergePreconditions rejects an archived source', () => {
  const db = getDb()
  const id = seedThought({ content: 'archived source', status: 'archived' })
  const source = getThoughtRow(db, id)!

  expect(() => validateMergePreconditions(source)).toThrow(
    new ValidationError('Source thought is already archived')
  )
})

test('validateMergePreconditions rejects a profile source', () => {
  const db = getDb()
  const id = seedThought({ content: 'profile source', is_profile: 1 })
  const source = getThoughtRow(db, id)!

  expect(() => validateMergePreconditions(source)).toThrow(
    new ValidationError('Cannot merge a profile thought away — clear the is_profile flag first')
  )
})

test('validateMergePreconditions allows merging into a profile target', () => {
  const db = getDb()
  const sourceId = seedThought({ content: 'regular source' })
  seedThought({ content: 'profile target', is_profile: 1 })
  const source = getThoughtRow(db, sourceId)!

  expect(() => validateMergePreconditions(source)).not.toThrow()
})
