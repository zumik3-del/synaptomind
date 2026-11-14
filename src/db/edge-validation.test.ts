import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../context/container'
import { ValidationError } from '../errors'
import { closeDb } from './init'
import {
  EDGE_TYPES,
  SYMMETRIC_EDGE_TYPES,
  isValidEdgeType,
  validateClusterConstraint,
  validateRetype
} from './edge-validation'
import type { Edge } from './edges'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'

beforeEach(createTestDb)
afterEach(closeDb)

function seedCluster(): string {
  const id = seedThought({ content: 'cluster thought', is_cluster: 1 })
  return id
}

function edgeOf(sourceId: string, targetId: string, type = 'develops'): Edge {
  const id = seedEdge(sourceId, targetId, type)
  return getDb().prepare(`SELECT * FROM edges WHERE id = ?`).get(id) as Edge
}

test('the edge vocabulary has nine types and exactly two symmetric ones', () => {
  expect(EDGE_TYPES).toHaveLength(9)
  expect(new Set(EDGE_TYPES).size).toBe(9)
  expect([...SYMMETRIC_EDGE_TYPES].sort()).toEqual(['contradicts', 'related'])
  for (const type of EDGE_TYPES) expect(isValidEdgeType(type)).toBeTrue()
})

test('an unknown type is not valid', () => {
  for (const type of ['', 'child', 'Children', 'frobnicates']) {
    expect(isValidEdgeType(type)).toBeFalse()
  }
})

test("a 'cluster' edge must start at a cluster and cannot target one", () => {
  const db = getDb()
  const cluster = seedCluster()
  const member = seedThought({ content: 'member' })
  const otherCluster = seedCluster()

  expect(() => validateClusterConstraint(db, member, cluster, 'cluster')).toThrow(
    "Only cluster thoughts can create 'cluster' edges"
  )
  expect(() => validateClusterConstraint(db, cluster, otherCluster, 'cluster')).toThrow(
    'Cluster edges cannot target another cluster thought'
  )
  expect(() => validateClusterConstraint(db, cluster, member, 'cluster')).not.toThrow()
})

test("a 'references' edge connects clusters to clusters only", () => {
  const db = getDb()
  const cluster = seedCluster()
  const otherCluster = seedCluster()
  const plain = seedThought({ content: 'plain' })

  expect(() => validateClusterConstraint(db, cluster, plain, 'references')).toThrow(
    "Clusters can reference only other clusters via 'references'"
  )
  expect(() => validateClusterConstraint(db, plain, cluster, 'references')).toThrow(
    "Non-cluster thoughts cannot use 'references' to link to clusters"
  )
  expect(() => validateClusterConstraint(db, cluster, otherCluster, 'references')).not.toThrow()
})

test('other types reject a cluster on either endpoint', () => {
  const db = getDb()
  const cluster = seedCluster()
  const plain = seedThought({ content: 'plain' })

  expect(() => validateClusterConstraint(db, cluster, plain, 'develops')).toThrow(
    "Cluster thoughts cannot have 'develops' edges"
  )
  expect(() => validateClusterConstraint(db, plain, cluster, 'develops')).toThrow(
    "Cannot link to cluster thought using 'develops' edge"
  )
  expect(() => validateClusterConstraint(db, plain, plain, 'develops')).not.toThrow()
})

test('validateRetype rejects an unknown type before it looks at the edge', () => {
  const db = getDb()
  const edge = edgeOf(seedThought(), seedThought())

  expect(() => validateRetype(db, edge, 'frobnicates')).toThrow(
    "Invalid edge type 'frobnicates'. Valid types: related"
  )
})

test('validateRetype rejects a no-op retype', () => {
  const db = getDb()
  const edge = edgeOf(seedThought(), seedThought(), 'supports')

  expect(() => validateRetype(db, edge, 'supports')).toThrow(
    `Edge ${edge.id} is already of type 'supports'`
  )
  expect(() => validateRetype(db, edge, 'supports')).toThrow(ValidationError)
})

test('validateRetype applies the cluster constraint to the new type', () => {
  const db = getDb()
  const cluster = seedCluster()
  const member = seedThought({ content: 'member' })
  const edge = edgeOf(cluster, member, 'cluster')

  expect(() => validateRetype(db, edge, 'related')).toThrow(
    "Cluster thoughts cannot have 'related' edges"
  )
  expect(() => validateRetype(db, edge, 'references')).toThrow(
    "Clusters can reference only other clusters via 'references'"
  )
})
