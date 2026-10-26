import { Hono } from 'hono'
import { getHealthService } from '../services/health.service'
import { authMiddleware } from '../middleware/auth'
import { apiRateLimitMiddleware } from '../middleware/rate-limit'
import { errorHandler } from './error-handler'
import { healthCheckRouter } from './health-check'

/**
 * The public HTTP app is an **ops plane**, not a second agent API (ADR
 * synaptomind/adr/2026-10-26-shrink-http-api-to-ops-endpoints.md, task #2202):
 * `GET /health` for liveness/readiness and the `/api/health-check` pair for a
 * report an operator can act on. Every former `/api/*` capability lives in the
 * MCP surface over `services/`, so there is exactly one wire contract for
 * agents. A removed route fails loudly with Hono's default 404 — a deprecation
 * shim would keep the transport drift alive instead of deleting it.
 */
export function createApp(): Hono {
  const app = new Hono()

  app.onError(errorHandler)
  // Auth, rate limiting and the 5 MB body guard still protect the two surviving
  // /api routes; /health stays public and uninstrumented (see below).
  app.use('/api/*', authMiddleware)
  app.use('/api/*', apiRateLimitMiddleware)

  app.use('/api/*', async (c, next) => {
    const contentLength = parseInt(c.req.header('content-length') || '0', 10)
    if (contentLength > 5_242_880) {
      return c.json({ error: 'Request body too large (max 5MB)' }, 413)
    }
    return next()
  })

  app.route('/api', healthCheckRouter)

  // /health is a pure liveness probe (no memory/graph operation) and stays uninstrumented.
  app.get('/health', c => {
    const health = getHealthService()
    return c.json(health, health.status === 'ok' ? 200 : 503)
  })

  return app
}
