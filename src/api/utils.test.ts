import { expect, test } from 'bun:test'
import type { Context } from 'hono'
import { z } from 'zod/v4'
import { ValidationError } from '../errors'
import { jsonBodyOrDefault } from './utils'

function makeContext(body?: string): Context {
  return {
    req: new Request('http://localhost/api/health-check/repair', {
      method: 'POST',
      ...(body === undefined ? {} : { body })
    })
  } as unknown as Context
}

const schema = z.object({
  confirm: z.boolean().optional(),
  severity: z.enum(['critical', 'warning', 'info']).optional()
})
const DEFAULT = { confirm: false }

test('an absent body returns the default', async () => {
  expect(await jsonBodyOrDefault(makeContext(), DEFAULT)).toEqual({ confirm: false })
})

test('an empty or whitespace-only body returns the default', async () => {
  expect(await jsonBodyOrDefault(makeContext(''), DEFAULT)).toEqual({ confirm: false })
  expect(await jsonBodyOrDefault(makeContext('   \n\t '), DEFAULT)).toEqual({ confirm: false })
})

test('a JSON null literal returns the default instead of dereferencing null', async () => {
  expect(await jsonBodyOrDefault(makeContext('null'), DEFAULT)).toEqual({ confirm: false })
})

test('a malformed body throws ValidationError, not a 500', async () => {
  await expect(jsonBodyOrDefault(makeContext('{not json'), DEFAULT)).rejects.toThrow(
    ValidationError
  )
})

test('a payload that violates the schema throws ValidationError naming the field', async () => {
  await expect(
    jsonBodyOrDefault(makeContext('{"severity":"loud"}'), DEFAULT, schema)
  ).rejects.toThrow(ValidationError)
})

test('multiple validation issues are joined in schema order', async () => {
  const input = z.object({ a: z.string('first issue'), b: z.number('second issue') })
  await expect(
    jsonBodyOrDefault(makeContext('{"a":1,"b":"x"}'), { a: '', b: 0 }, input)
  ).rejects.toThrow('first issue; second issue')
})

test('a valid payload is parsed and validated', async () => {
  expect(
    await jsonBodyOrDefault(makeContext('{"confirm":true,"severity":"critical"}'), DEFAULT, schema)
  ).toEqual({
    confirm: true,
    severity: 'critical'
  })
})

test('without a schema the payload is returned as parsed', async () => {
  const parsed = await jsonBodyOrDefault<Record<string, unknown>>(
    makeContext('{"anything":[1,2]}'),
    {}
  )
  expect(parsed).toEqual({ anything: [1, 2] })
})
