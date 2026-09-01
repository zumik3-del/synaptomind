import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb } from '../db/init'
import { extractEntities, getEntitiesForThought, listEntities, syncEntities, entitySearchIds } from './entity.service'

beforeEach(createTestDb)
afterEach(closeDb)

test('syncEntities extracts and stores entities', () => {
  const id = seedThought({ content: 'test thought with `getCode` function' })
  syncEntities(id, 'test thought with `getCode` function')
  const entities = getEntitiesForThought(id)
  expect(entities.length).toBeGreaterThanOrEqual(1)
  expect(entities.some(e => e.entity_name === 'getcode')).toBeTrue()
})

test('syncEntities replaces old entities', () => {
  const id = seedThought()
  syncEntities(id, 'first `alpha` version')
  syncEntities(id, 'second `beta` version')
  const entities = getEntitiesForThought(id)
  expect(entities.some(e => e.entity_name === 'beta')).toBeTrue()
  expect(entities.some(e => e.entity_name === 'alpha')).toBeFalse()
})

test('getEntitiesForThought returns empty for unknown id', () => {
  expect(getEntitiesForThought('nonexistent')).toEqual([])
})

test('entitySearchIds finds matching thoughts', () => {
  const id = seedThought()
  syncEntities(id, 'uses `QueryBuilder` pattern')
  const results = entitySearchIds('querybuilder', 10)
  expect(results).toContain(id)
})

test('entitySearchIds returns empty for short tokens', () => {
  expect(entitySearchIds('a', 10)).toEqual([])
})

test('entitySearchIds returns empty for no match', () => {
  expect(entitySearchIds('zzzznonexistent', 10)).toEqual([])
})

test('listEntities returns all entities', () => {
  const id = seedThought()
  syncEntities(id, 'test `MyService` here')
  const all = listEntities()
  expect(all.length).toBeGreaterThanOrEqual(1)
})

test('listEntities filters by type', () => {
  const id = seedThought()
  syncEntities(id, 'test `MyService` and #important')
  const code = listEntities({ type: 'code' })
  expect(code.every(e => e.type === 'code')).toBeTrue()
  const tags = listEntities({ type: 'tag' })
  expect(tags.every(e => e.type === 'tag')).toBeTrue()
})

test('extractEntities is re-exported from entity.service', () => {
  expect(typeof extractEntities).toBe('function')
})
