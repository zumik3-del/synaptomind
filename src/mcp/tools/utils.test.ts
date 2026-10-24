import { describe, expect, test } from 'bun:test'
import { jsonResult } from './utils'

// Runtime assertion for #2135 AC-3: no tool result may be a bare string.
// `jsonResult` wraps a bare string payload as `{ text }` so the shared
// `{ result }` envelope never carries a string in `result`.
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
