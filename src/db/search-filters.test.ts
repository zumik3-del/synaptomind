import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../context/container'
import { closeDb } from './init'
import { seedThought, createTestDb } from '../test/helpers'
import { buildFilterSQL, buildResidualFilterSQL, buildVecScopeSQL } from './search-filters'

beforeEach(createTestDb)
afterEach(closeDb)

test('no filters render no SQL and bind no parameters', () => {
  expect(buildFilterSQL(getDb(), {})).toEqual({ sql: '', params: [] })
  expect(buildResidualFilterSQL(getDb(), {})).toEqual({ sql: '', params: [] })
})

test('each filter contributes its fragment and parameters in declaration order', () => {
  const db = getDb()
  seedThought({ tags: '["alpha"]' })

  const fragment = buildFilterSQL(db, {
    statusFilter: 'active',
    projectFilter: 'default',
    clusterFilter: 'exclude',
    minImportance: 0.5,
    tagFilter: 'alpha'
  })

  expect(fragment.sql).toContain('AND t.status = ? ')
  expect(fragment.sql).toContain('AND (t.project_id = ? OR t.is_global = 1) ')
  expect(fragment.sql).toContain('AND (t.is_cluster IS NULL OR t.is_cluster = 0) ')
  expect(fragment.sql).toContain('AND ti.importance >= ? ')
  expect(fragment.sql).toContain('AND t.id IN (')
  expect(fragment.params.slice(0, 3)).toEqual(['active', 'default', 0.5])
  expect(fragment.params.at(-1)).toBe(1)
})

test("the 'only' cluster filter keeps cluster thoughts", () => {
  const fragment = buildFilterSQL(getDb(), { clusterFilter: 'only' })

  expect(fragment.sql).toBe('AND t.is_cluster = 1 ')
  expect(fragment.params).toEqual([])
})

test('a zero minimum importance is not a filter, so the zero-importance tail is not lost', () => {
  expect(buildFilterSQL(getDb(), { minImportance: 0 }).sql).toBe('')
})

test('the residual form applies every filter but the project one', () => {
  const db = getDb()
  seedThought({ tags: '["alpha"]' })

  const fragment = buildResidualFilterSQL(db, {
    statusFilter: 'active',
    projectFilter: 'default',
    clusterFilter: 'only',
    minImportance: 0.25,
    tagFilter: 'alpha'
  })

  expect(fragment.sql).not.toContain('project_id')
  expect(fragment.sql).toContain('AND t.status = ? ')
  expect(fragment.sql).toContain('AND t.is_cluster = 1 ')
  expect(fragment.sql).toContain('AND ti.importance >= ? ')
  expect(fragment.params[0]).toBe('active')
  expect(fragment.params[1]).toBe(0.25)
  expect(fragment.params[2]).toBe('alpha')
  expect(fragment.params).toHaveLength(5)
  expect(fragment.params.at(-1)).toBe(1)
})

test('a tag expression that parses to nothing adds no fragment', () => {
  expect(buildFilterSQL(getDb(), { tagFilter: ' , ' }).sql).toBe('')
})

test('an unknown tag renders the empty-matching predicate instead of dropping the filter', () => {
  const fragment = buildFilterSQL(getDb(), { tagFilter: 'no-such-tag' })

  expect(fragment.sql).toBe('AND 1 = 0 ')
  expect(fragment.params).toEqual([])
})

test('the vector scope filter widens a project scope with the global sentinel', () => {
  expect(buildVecScopeSQL({})).toEqual({ sql: '', params: [] })
  expect(buildVecScopeSQL({ projectFilter: 'proj-1' })).toEqual({
    sql: "AND v.scope IN (?, '__global__') ",
    params: ['proj-1']
  })
})
