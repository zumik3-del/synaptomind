import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { EmbedderNotReadyError } from '../../services/errors'

export function errorHandler(err: Error, c: Context) {
  if (err instanceof EmbedderNotReadyError) {
    return c.json({ error: 'Search unavailable: model is still loading.' }, 503)
  }
  if ('statusCode' in err) {
    return c.json({ error: err.message }, (err as { statusCode: ContentfulStatusCode }).statusCode)
  }
  console.error('[synaptomind] unhandled error:', err)
  return c.json({ error: 'Internal server error' }, 500)
}
