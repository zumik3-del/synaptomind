import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb, getDb } from '../db'
import { createClusterService } from './cluster.service'
import { NotFoundError, ValidationError } from './errors'

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
