import type { Context } from 'hono'

export async function jsonBodyOrDefault<T>(c: Context, defaultValue: T): Promise<T> {
  try {
    const body = await c.req.json<T>()
    return body ?? defaultValue
  } catch {
    return defaultValue
  }
}
