import { expect, test } from 'bun:test'
import { COMPACT_FIELDS, projectFields, resolveFields, toStringArray } from './field-selection'

test('toStringArray normalizes the four wire shapes to a trimmed list', () => {
  expect(toStringArray(undefined)).toEqual([])
  expect(toStringArray(null)).toEqual([])
  expect(toStringArray([' id ', '', 'content'])).toEqual(['id', 'content'])
  expect(toStringArray('id, content ,,tags')).toEqual(['id', 'content', 'tags'])
  expect(toStringArray(7)).toEqual(['7'])
})

test('an empty selection resolves to no projection', () => {
  expect(resolveFields()).toEqual([])
  expect(resolveFields(['', '  '])).toEqual([])
  expect(resolveFields({})).toEqual([])
})

test('compact projects the five compact fields', () => {
  expect(resolveFields(true)).toEqual([...COMPACT_FIELDS])
  expect(resolveFields({ compact: true })).toEqual([...COMPACT_FIELDS])
  expect(resolveFields({ compact: 'true' })).toEqual([...COMPACT_FIELDS])
  expect(resolveFields({ compact: 'false' })).toEqual([])
  expect(resolveFields(false)).toEqual([])
})

test('explicit fields win over compact and keep their order', () => {
  expect(resolveFields(true, ['content', 'id'])).toEqual(['content', 'id'])
  expect(resolveFields({ fields: 'id, tags' })).toEqual(['id', 'tags'])
  // A bare string is one field name; only the object form splits on commas.
  expect(resolveFields('id,tags')).toEqual(['id,tags'])
})

test('every supported alias names the requested field list', () => {
  for (const key of ['field', 'requested', 'requestedFields', 'selected']) {
    expect(resolveFields({ [key]: 'content' })).toEqual(['content'])
  }
})

test('the available list filters the projection and removes duplicates', () => {
  expect(
    resolveFields(['id', 'secret', 'id', 'content'], { available: ['id', 'content'] })
  ).toEqual(['id', 'content'])
  expect(resolveFields({ fields: ['nope'] }, { availableFields: ['id'] })).toEqual([])
  expect(resolveFields({ availableColumns: ['id', 'content'] })).toEqual(['id', 'content'])
})

test('two positional arrays are read as fields then available', () => {
  expect(resolveFields(['id', 'nope'], ['id', 'content'])).toEqual(['id'])
  expect(resolveFields(['id', 'content'])).toEqual(['id', 'content'])
  expect(resolveFields(['id'], { fields: ['content'] })).toEqual(['content'])
})

test('a nested options object is read like the arguments it wraps', () => {
  expect(resolveFields({ options: { fields: ['id'] } })).toEqual(['id'])
  expect(resolveFields({ options: { compact: true } })).toEqual([...COMPACT_FIELDS])
  expect(resolveFields({ options: { fields: ['id'], available: ['id', 'tags'] } })).toEqual(['id'])
})

test('duplicates collapse in an unfiltered projection', () => {
  expect(resolveFields(['id', 'id', 'content', 'content'])).toEqual(['id', 'content'])
})

test('projectFields keeps only the requested keys of one thought', () => {
  const thought = { id: 't1', content: 'body', status: 'active', tags: ['a'] }

  expect(projectFields(thought, ['id', 'content'])).toEqual({ id: 't1', content: 'body' })
  expect(projectFields(thought, { fields: ['id'] })).toEqual({ id: 't1' })
  expect(projectFields(thought, 'id')).toEqual({ id: 't1' })
})

test('a projection naming no present key yields an empty object, not the whole thought', () => {
  expect(projectFields({ id: 't1' }, ['nope'])).toEqual({})
})

test('the argument order is forgiven: a field list first projects the object second', () => {
  const thought = { id: 't1', content: 'body' }

  expect(projectFields(['id'], thought)).toEqual({ id: 't1' })
  expect(projectFields('id', thought)).toEqual({ id: 't1' })
})

test('an array of items projects each one', () => {
  const items = [
    { id: 'a', content: 'one', extra: 1 },
    { id: 'b', content: 'two', extra: 2 }
  ]

  expect(projectFields(items, ['id'])).toEqual([{ id: 'a' }, { id: 'b' }])
})

test('without a field list the item is returned untouched', () => {
  const thought = { id: 't1', content: 'body' }

  expect(projectFields(thought)).toBe(thought)
  expect((projectFields([thought]) as unknown[])[0]).toBe(thought)
  expect(projectFields(thought, {})).toBe(thought)
})

test('a single object carrying its own fields selects them', () => {
  const thought = { id: 't1', content: 'body', status: 'active' }

  expect(projectFields({ ...thought, fields: ['status'] })).toEqual({ status: 'active' })
  expect(projectFields({ ...thought, compact: true })).toEqual({
    id: 't1',
    content: 'body',
    status: 'active',
    tags: undefined,
    project: undefined
  })
})

test('primitives and null pass through a projection unharmed', () => {
  expect(projectFields(null, ['id'])).toBeNull()
  expect(projectFields('text', ['id'])).toBe('text')
  expect(projectFields(7, ['id'])).toBe(7)
})
