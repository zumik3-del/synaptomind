import type { Context } from 'hono'
import type { z } from 'zod/v4'
import { ValidationError } from '../errors'

/** Join zod issue messages into the single message a 400 body carries. */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues.map(issue => issue.message).join('; ')
}

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

/** Read the request body as text; an absent/empty payload reads as `''`. */
async function readBody(c: Context): Promise<string> {
  return (await c.req.text()).trim()
}

/**
 * Read an optional JSON request body.
 *
 * The default is applied to an *absent* body and to a JSON `null` literal (both
 * mean "no payload"): a malformed payload and a schema mismatch both map to
 * `ValidationError` (HTTP 400) instead of being silently replaced by defaults
 * (audit M8). Pass `schema` to validate the parsed body through the shared
 * request contract (`src/validation.ts`).
 */
export async function jsonBodyOrDefault<T>(c: Context, defaultValue: T, schema?: z.ZodType<T>): Promise<T> {
  const raw = await readBody(c)
  if (raw === '') return defaultValue
  const parsed = parseJson(raw)
  // A JSON `null` literal means "no payload" too: without this guard the bare
  // `null` reaches the call site and dereferences into a 500 (audit M8).
  if (parsed === null) return defaultValue
  return schema ? validate(parsed, schema) : (parsed as T)
}

/**
 * Read a JSON body that the endpoint requires. An absent body, malformed JSON
 * and a schema mismatch all map to `ValidationError` (HTTP 400).
 */
export async function requiredJsonBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const raw = await readBody(c)
  if (raw === '') throw new ValidationError('Request body is required')
  return validate(parseJson(raw), schema)
}
