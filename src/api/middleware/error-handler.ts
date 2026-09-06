import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { EmbedderNotReadyError } from '../../errors'

function isDomainError(err: unknown): err is Error & { statusCode: ContentfulStatusCode } {
  return (
    err instanceof Error &&
    'statusCode' in err &&
    typeof (err as { statusCode: unknown }).statusCode === 'number' &&
    (err as { statusCode: number }).statusCode >= 400 &&
    (err as { statusCode: number }).statusCode < 600
  )
}

export function errorHandler(err: Error, c: Context) {
  if (err instanceof EmbedderNotReadyError) {
    return c.json({ error: 'Search unavailable: model is still loading.' }, 503)
  }
  if (isDomainError(err)) {
    return c.json({ error: err.message }, err.statusCode)
  }
  console.error('[synaptomind] unhandled error:', err)
  return c.json({ error: 'Internal server error' }, 500)
}
