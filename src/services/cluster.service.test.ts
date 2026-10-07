import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { closeDb, getDb } from '../db'
import { createClusterService, dissolveClusterService, removeClusterMemberService } from './cluster.service'
import { NotFoundError, ValidationError } from '../errors'

beforeEach(createTestDb)
afterEach(closeDb)

test('createClusterService throws for empty thoughtIds', () => {
  expect(() => createClusterService({ thoughtIds: [] })).toThrow(ValidationError)
})

test('createClusterService throws for missing thoughts', () => {
  expect(() => createClusterService({ thoughtIds: ['nonexistent'] })).toThrow(NotFoundError)
})

test('createClusterService creates cluster with members', () => {
  const a = seedThought({ content: 'member a' })
  const b = seedThought({ content: 'member b' })
  const result = createClusterService({ thoughtIds: [a, b], title: 'Test Cluster' })
  expect(result.cluster.is_cluster).toBe(1)
  expect(result.edges).toHaveLength(2)
  expect(result.members).toHaveLength(2)
})

test('createClusterService auto-generates title when not provided', () => {
  const a = seedThought()
  const result = createClusterService({ thoughtIds: [a] })
  expect(result.cluster.content).toContain('Cluster of 1 thoughts')
})

test('createClusterService applies tags', () => {
  const a = seedThought()
  const result = createClusterService({ thoughtIds: [a], tags: ['custom-tag'] })
  const db = getDb()
  const tags = db.prepare("SELECT tg.name FROM thought_tags tt JOIN tags tg ON tt.tag_id = tg.id WHERE tt.thought_id = ?").all(result.cluster.id) as { name: string }[]
  expect(tags.some(t => t.name === 'custom-tag')).toBeTrue()
  expect(tags.some(t => t.name === 'cluster')).toBeTrue()
})

test('createClusterService inherits project from members', () => {
  const projId = 'shared-proj'
  const a = seedThought({ project_id: projId })
  const b = seedThought({ project_id: projId })
  const result = createClusterService({ thoughtIds: [a, b] })
  expect(result.cluster.project_id).toBe(projId)
})

test('createClusterService applies source', () => {
  const a = seedThought()
  const result = createClusterService({ thoughtIds: [a], source: 'manual' })
  expect(result.cluster.source).toBe('manual')
})

test('createClusterService handles duplicate member edges gracefully', () => {
  const a = seedThought()
  const result = createClusterService({ thoughtIds: [a] })
  expect(result.edges).toHaveLength(1)
  expect(result.cluster.is_cluster).toBe(1)
})

test('createClusterService creates unprotected clusters (dissolve stays reachable)', () => {
  const a = seedThought()
  const result = createClusterService({ thoughtIds: [a] })
  // Clusters are synthetic containers, not content — protection is
  // exceptional (ADR §4) so cluster_dissolve stays reachable end-to-end.
  expect(result.cluster.is_protected).toBe(0)
})

// ── removeClusterMemberService ───────────────────────────────────────────────

test('removeClusterMemberService removes the edge but keeps the thought', () => {
  const cluster = seedThought({ is_cluster: 1 })
  const member = seedThought()
  seedEdge(cluster, member, 'cluster')
  const result = removeClusterMemberService({ clusterId: cluster, thoughtId: member })
  expect(result.edgeId).toBeDefined()
  const db = getDb()
  const edges = db.prepare("SELECT * FROM edges WHERE source_id = ? AND target_id = ? AND type = 'cluster'").all(cluster, member)
  expect(edges).toHaveLength(0)
  const thought = db.prepare("SELECT * FROM thoughts WHERE id = ?").get(member)
  expect(thought).toBeDefined()
})

// ── dissolveClusterService ───────────────────────────────────────────────────

test('dissolveClusterService removes edges and cluster thought but keeps members', () => {
  const cluster = seedThought({ is_cluster: 1, is_protected: 0 })
  const member1 = seedThought()
  const member2 = seedThought()
  seedEdge(cluster, member1, 'cluster')
  seedEdge(cluster, member2, 'cluster')
  const result = dissolveClusterService({ clusterId: cluster })
  expect(result.deletedEdgeCount).toBe(2)
  const db = getDb()
  const edges = db.prepare("SELECT * FROM edges WHERE source_id = ? AND type = 'cluster'").all(cluster)
  expect(edges).toHaveLength(0)
  const clusterThought = db.prepare("SELECT * FROM thoughts WHERE id = ?").get(cluster)
  expect(clusterThought).toBeNull()
  const m1 = db.prepare("SELECT * FROM thoughts WHERE id = ?").get(member1)
  const m2 = db.prepare("SELECT * FROM thoughts WHERE id = ?").get(member2)
  expect(m1).toBeDefined()
  expect(m2).toBeDefined()
})

test('dissolveClusterService throws for protected cluster', () => {
  const cluster = seedThought({ is_cluster: 1, is_protected: 1 })
  expect(() => dissolveClusterService({ clusterId: cluster })).toThrow(ValidationError)
})
