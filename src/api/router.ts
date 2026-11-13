import { Hono } from 'hono'
import { getHealthService } from '../services/health.service'
import { authMiddleware } from '../middleware/auth'
import { bindUserContext } from '../middleware/user-context'
import { createRateLimitMiddleware } from '../middleware/rate-limit'
import { errorHandler } from './error-handler'
import { healthCheckRouter } from './health-check'

export function createApp(): Hono {
  const app = new Hono()
  const rateLimit = createRateLimitMiddleware()

  app.onError(errorHandler)
  app.use('/api/*', authMiddleware)
  app.use('/api/*', bindUserContext)
  app.use('/api/*', rateLimit)

  app.use('/api/*', async (c, next) => {
    const contentLength = parseInt(c.req.header('content-length') || '0', 10)
    if (contentLength > 5_242_880) {
      return c.json({ error: 'Request body too large (max 5MB)' }, 413)
    }
    return next()
  })

  app.route('/api', healthCheckRouter)

  app.get('/health', c => {
    const health = getHealthService()
    return c.json(health, health.status === 'ok' ? 200 : 503)
  })

  return app
}
