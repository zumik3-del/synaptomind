import { Hono } from 'hono'
import { getHealthService } from '../services/health.service'
import { createGuardedPipeline } from '../middleware/guarded-pipeline'
import { errorHandler } from './error-handler'
import { healthCheckRouter } from './health-check'

export function createApp(): Hono {
  const app = new Hono()

  app.onError(errorHandler)
  for (const guard of createGuardedPipeline({ shape: 'json' })) app.use('/api/*', guard)

  app.route('/api', healthCheckRouter)

  app.get('/health', c => {
    const health = getHealthService()
    return c.json(health, health.status === 'ok' ? 200 : 503)
  })

  return app
}
