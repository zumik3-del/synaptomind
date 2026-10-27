import { expect, test } from 'bun:test'
import type { Context } from 'hono'
import { z } from 'zod/v4'
import { ValidationError } from '../errors'
import { jsonBodyOrDefault } from './utils'

// `jsonBodyOrDefault` is the one surviving piece of the old HTTP request
// contract (ADR 2026-10-26): the ops plane's repair route still reads an
// optional JSON body through it. These cases came out of the deleted
// route-level contract suite, retargeted at the helper itself.

/** A minimal Hono context whose only used surface is `c.req.text()`. */
function makeContext(body?: string): Context {
  return {
    req: new Request('http://localhost/api/health-check/repair', {
      method: 'POST',
      ...(body === undefined ? {} : { body })
    })
  } as unknown as Context
}

const schema = z.object({ confirm: z.boolean().optional(), severity: z.enum(['critical', 'warning', 'info']).optional() })
const DEFAULT = { confirm: false }

test('an absent body returns the default', async () => {
  expect(await jsonBodyOrDefault(makeContext(), DEFAULT)).toEqual({ confirm: false })
})

test('an empty or whitespace-only body returns the default', async () => {
  expect(await jsonBodyOrDefault(makeContext(''), DEFAULT)).toEqual({ confirm: false })
  expect(await jsonBodyOrDefault(makeContext('   \n\t '), DEFAULT)).toEqual({ confirm: false })
})

test('a JSON null literal returns the default instead of dereferencing null', async () => {
  // Before #1787 the bare `null` reached the caller and became a 500.
  expect(await jsonBodyOrDefault(makeContext('null'), DEFAULT)).toEqual({ confirm: false })
})

test('a malformed body throws ValidationError, not a 500', async () => {
  await expect(jsonBodyOrDefault(makeContext('{not json'), DEFAULT)).rejects.toThrow(ValidationError)
})

test('a payload that violates the schema throws ValidationError naming the field', async () => {
  await expect(jsonBodyOrDefault(makeContext('{"severity":"loud"}'), DEFAULT, schema)).rejects.toThrow(ValidationError)
})

test('a valid payload is parsed and validated', async () => {
  expect(await jsonBodyOrDefault(makeContext('{"confirm":true,"severity":"critical"}'), DEFAULT, schema)).toEqual({
    confirm: true,
    severity: 'critical'
  })
})

test('without a schema the payload is returned as parsed', async () => {
  const parsed = await jsonBodyOrDefault<Record<string, unknown>>(makeContext('{"anything":[1,2]}'), {})
  expect(parsed).toEqual({ anything: [1, 2] })
})
