import type { Context } from 'hono'
import type { z } from 'zod/v4'
import { ValidationError } from '../errors'
import { formatZodIssues } from '../zod-utils'

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new ValidationError('Malformed JSON body')
  }
}

function validate<T>(parsed: unknown, schema: z.ZodType<T>): T {
  const result = schema.safeParse(parsed)
  if (!result.success) throw new ValidationError(formatZodIssues(result.error))
  return result.data
}

async function readBody(c: Context): Promise<string> {
  return (await c.req.text()).trim()
}

export async function jsonBodyOrDefault<T>(
  c: Context,
  defaultValue: T,
  schema?: z.ZodType<T>
): Promise<T> {
  const raw = await readBody(c)
  if (raw === '') return defaultValue
  const parsed = parseJson(raw)
  if (parsed === null) return defaultValue
  return schema ? validate(parsed, schema) : (parsed as T)
}
