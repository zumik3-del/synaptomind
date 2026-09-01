import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { closeDb, getDb } from '../db'
import { crystallize } from './crystals.service'
import { ValidationError } from './errors'

beforeEach(createTestDb)
afterEach(closeDb)

test('crystallize throws when no input', () => {
  expect(() => crystallize({})).toThrow(ValidationError)
})

test('crystallize throws for invalid style', () => {
  expect(() => crystallize({ thought_ids: ['x'], style: 'invalid' as any })).toThrow(ValidationError)
})

test('crystallize throws for non-existent cluster_id', () => {
  expect(() => crystallize({ cluster_id: 'nonexistent' })).toThrow(ValidationError)
})

test('crystallize throws when all members archived', () => {
  const id = seedThought({ status: 'archived' })
  expect(() => crystallize({ thought_ids: [id] })).toThrow(ValidationError)
})

test('crystallize creates crystal from thought_ids', () => {
  const a = seedThought({ content: 'first thought' })
  const b = seedThought({ content: 'second thought' })
  const result = crystallize({ thought_ids: [a, b], style: 'overview' })
  expect(result.crystal_id).toBeString()
  expect(result.style).toBe('overview')
  expect(result.members_used).toBe(2)
  expect(result.content).toContain('# Crystal:')
  expect(result.content).toContain('first thought')
})

test('crystallize creates crystal from cluster_id', () => {
  const a = seedThought({ content: 'member a' })
  const b = seedThought({ content: 'member b' })
  const clusterId = seedThought({ content: 'My Cluster Title', is_cluster: 1 })
  seedEdge(clusterId, a, 'cluster')
  seedEdge(clusterId, b, 'cluster')
  const result = crystallize({ cluster_id: clusterId })
  expect(result.members_used).toBe(2)
  expect(result.content).toContain('My Cluster Title')
})

test('crystallize buckets gotcha-tagged thoughts', () => {
  const a = seedThought({ content: 'normal thought' })
  const b = seedThought({ content: 'gotcha here', tags: '["gotcha"]' })
  const result = crystallize({ thought_ids: [a, b] })
  expect(result.content).toContain('## Gotchas')
  expect(result.content).toContain('gotcha here')
})

test('crystallize buckets draft thoughts as open', () => {
  const a = seedThought({ content: 'done thought', status: 'active' })
  const b = seedThought({ content: 'todo thought', status: 'draft' })
  const result = crystallize({ thought_ids: [a, b] })
  expect(result.content).toContain('## Open questions')
  expect(result.content).toContain('todo thought')
})

test('crystallize applies project_id to crystal', () => {
  const id = seedThought({ content: 'test' })
  const result = crystallize({ thought_ids: [id], project_id: 'proj-1' })
  const db = getDb()
  const crystal = db.prepare('SELECT project_id FROM thoughts WHERE id = ?').get(result.crystal_id) as { project_id: string }
  expect(crystal.project_id).toBe('proj-1')
})

test('crystallize defaults to decision-log style', () => {
  const id = seedThought({ content: 'a decision' })
  const result = crystallize({ thought_ids: [id] })
  expect(result.style).toBe('decision-log')
  expect(result.content).toContain('## Decisions')
})

test('crystallize runbook style labels', () => {
  const id = seedThought({ content: 'procedure step' })
  const result = crystallize({ thought_ids: [id], style: 'runbook' })
  expect(result.content).toContain('## Procedure')
})
