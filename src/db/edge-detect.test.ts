import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { getDb } from './container'
import { closeDb } from './init'
import { findDetectionCandidates } from './edge-detect'

beforeEach(createTestDb)
afterEach(closeDb)

test('findDetectionCandidates returns active non-cluster, non-member thoughts', () => {
  const db = getDb()
  const a = seedThought({ content: 'active a' })
  const b = seedThought({ content: 'active b' })
  seedThought({ content: 'draft', status: 'draft' })
  const cluster = seedThought({ content: 'cluster', is_cluster: 1 })
  const member = seedThought({ content: 'member' })
  seedEdge(cluster, member, 'cluster')

  const candidates = findDetectionCandidates(db, undefined, 100)
  const ids = candidates.map(c => c.id)
  expect(ids).toContain(a)
  expect(ids).toContain(b)
  expect(ids).not.toContain(cluster)
  expect(ids).not.toContain(member)
})

test('findDetectionCandidates scopes to project', () => {
  const db = getDb()
  const x = seedThought({ content: 'x', project_id: 'proj-x' })
  const y = seedThought({ content: 'y', project_id: 'proj-y' })
  const ids = findDetectionCandidates(db, 'proj-x', 100).map(c => c.id)
  expect(ids).toContain(x)
  expect(ids).not.toContain(y)
})

test('findDetectionCandidates bounds limit', () => {
  seedThought({ content: 'one' })
  seedThought({ content: 'two' })
  seedThought({ content: 'three' })
  expect(findDetectionCandidates(getDb(), undefined, 2)).toHaveLength(2)
})

test('findDetectionCandidates returns empty when no candidates', () => {
  expect(findDetectionCandidates(getDb(), undefined, 10)).toEqual([])
})
