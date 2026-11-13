import { describe, expect, test } from 'bun:test'
import { toBit } from '../../db/utils'
import { parseTags } from '../../utils'
import { jsonResult, shapeThought } from './utils'

describe('jsonResult envelope', () => {
  test("wraps a bare string payload as { text: 'x' }", () => {
    const result = jsonResult('x')

    expect(result.structuredContent.result).toEqual({ text: 'x' })
    expect(typeof result.structuredContent.result).not.toBe('string')
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ text: 'x' }, null, 2) }])
  })

  test('passes object payloads through unchanged', () => {
    const result = jsonResult({ foo: 42 })

    expect(result.structuredContent.result).toEqual({ foo: 42 })
    expect(result.content[0].text).toBe(JSON.stringify({ foo: 42 }, null, 2))
  })

  test('passes array payloads through unchanged', () => {
    const result = jsonResult([1, 2, 3])

    expect(result.structuredContent.result).toEqual([1, 2, 3])
    expect(result.content[0].text).toBe(JSON.stringify([1, 2, 3], null, 2))
  })

  test('wraps a string the same way as a raw text tool would', () => {
    const result = jsonResult('hello world')

    expect(result.structuredContent.result).toEqual({ text: 'hello world' })
    expect(JSON.parse(result.content[0].text)).toEqual({ text: 'hello world' })
  })
})

test('thought output stringifies heterogeneous tags and strictly decodes boolean fields', () => {
  expect(
    shapeThought({
      tags: [' a ', { name: 'Name', tag: 'other' }, { tag: 'Tag' }, { id: 3 }, 4],
      is_protected: 1,
      is_global: '1',
      is_cluster: true
    })
  ).toEqual({
    tags: [' a ', 'Name', 'Tag', '3', '4'],
    is_protected: true,
    is_global: false,
    is_cluster: true
  })
})

test('input tag filtering and boolean encoding retain their distinct contracts', () => {
  expect(parseTags(' a , , b ')).toEqual(['a', 'b'])
  expect(parseTags(' , ')).toBeUndefined()
  expect(parseTags([' ', ' a '])).toEqual(['a'])
  expect([toBit(undefined), toBit(false), toBit(true)]).toEqual([0, 0, 1])
})
