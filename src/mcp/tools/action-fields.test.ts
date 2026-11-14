import { expect, test } from 'bun:test'
import { allActionFields, validateActionFields } from './action-fields'

const FIELDS = {
  create: ['content', 'tags', 'cwd'],
  update: ['thought_id', 'content', 'cwd'],
  delete: ['thought_id', 'cwd']
}

test('the union of action fields is the deduplicated vocabulary', () => {
  expect(allActionFields(FIELDS)).toEqual(new Set(['content', 'tags', 'cwd', 'thought_id']))
})

test('an argument that belongs to another action is refused with the field names', () => {
  const all = allActionFields(FIELDS)

  expect(() =>
    validateActionFields('create', { content: 'x', thought_id: 't1' }, FIELDS, all)
  ).toThrow('thought_id is not applicable to create action')
  expect(() =>
    validateActionFields('delete', { thought_id: 't1', tags: ['a'], content: 'x' }, FIELDS, all)
  ).toThrow('tags, content is not applicable to delete action')
})

test('shared and unrelated arguments pass, including keys outside the vocabulary', () => {
  const all = allActionFields(FIELDS)

  expect(() =>
    validateActionFields(
      'update',
      { thought_id: 't1', content: 'x', cwd: '/w', action: 'update' },
      FIELDS,
      all
    )
  ).not.toThrow()
  expect(() =>
    validateActionFields('create', { content: 'x', confirm: true }, FIELDS, all)
  ).not.toThrow()
})

test('an action the map does not describe accepts nothing from the vocabulary', () => {
  const all = allActionFields(FIELDS)

  expect(() => validateActionFields('unknown', { content: 'x' }, FIELDS, all)).toThrow(
    'content is not applicable to unknown action'
  )
})
