import { expect, test } from 'bun:test'
import { extractEntities } from './entity-extract'

test('extractEntities returns empty for empty content', () => {
  expect(extractEntities('')).toEqual([])
})

test('extractEntities extracts backtick-quoted code', () => {
  const result = extractEntities('use `getDb()` to connect')
  expect(result).toContainEqual({ name: 'getdb()', type: 'code' })
})

test('extractEntities extracts CamelCase identifiers', () => {
  const result = extractEntities('The ThoughtService handles CRUD')
  expect(result).toContainEqual({ name: 'thoughtservice', type: 'code' })
})

test('extractEntities extracts snake_case identifiers', () => {
  const result = extractEntities('config uses thought_limit_max')
  expect(result).toContainEqual({ name: 'thought_limit_max', type: 'code' })
})

test('extractEntities extracts hashtags as tags', () => {
  const result = extractEntities('marked as #important and #todo')
  expect(result).toContainEqual({ name: 'important', type: 'tag' })
  expect(result).toContainEqual({ name: 'todo', type: 'tag' })
})

test('extractEntities extracts code block languages', () => {
  const result = extractEntities('```typescript\nconst x = 1\n```')
  expect(result).toContainEqual({ name: 'typescript', type: 'code' })
})

test('extractEntities deduplicates entities', () => {
  const result = extractEntities('`getDb` and getDb are the same')
  const getDbEntries = result.filter(e => e.name === 'getdb')
  expect(getDbEntries).toHaveLength(1)
})

test('extractEntities normalizes to lowercase', () => {
  const result = extractEntities('Use `MyService` here')
  expect(result).toContainEqual({ name: 'myservice', type: 'code' })
})

test('extractEntities skips single-char entities', () => {
  const result = extractEntities('a and b are single letters')
  expect(result).toHaveLength(0)
})

test('extractEntities truncates entities over 100 chars', () => {
  const long = 'x'.repeat(101)
  const result = extractEntities(`\`${long}\``)
  expect(result).toHaveLength(1)
  expect(result[0].name).toHaveLength(100)
})

test('extractEntities prioritizes code over tag for same name', () => {
  const result = extractEntities('`todo` and #todo')
  const todoEntry = result.find(e => e.name === 'todo')
  expect(todoEntry?.type).toBe('code')
})

test('extractEntities handles mixed entities', () => {
  const result = extractEntities('The `ThoughtService` uses #active tag and snake_case_name')
  expect(result.length).toBeGreaterThanOrEqual(3)
  expect(result).toContainEqual({ name: 'thoughtservice', type: 'code' })
  expect(result).toContainEqual({ name: 'active', type: 'tag' })
  expect(result).toContainEqual({ name: 'snake_case_name', type: 'code' })
})

test('extractEntities does not extract hashtags starting with digit', () => {
  const result = extractEntities('not #123tag')
  expect(result).toHaveLength(0)
})

test('extractEntities does not extract hashtags starting with underscore', () => {
  const result = extractEntities('not #_hidden')
  expect(result).toHaveLength(0)
})
