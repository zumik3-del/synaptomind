import { Hono } from 'hono'
import { type Config, config } from '../config'
import { getHealthService } from '../services/health.service'
import { createBodyCap } from '../middleware/body-cap'
import { createGuardedPipeline } from '../middleware/guarded-pipeline'
import { errorHandler } from './error-handler'
import { healthCheckRouter } from './health-check'

export function createApp(cfg: Config = config): Hono {
  const app = new Hono()

  app.onError(errorHandler)
  for (const guard of createGuardedPipeline({ shape: 'json', config: cfg }))
    app.use('/api/*', guard)
  // Behind the pipeline, so an unauthenticated or rate-limited request never has its body read.
  app.use('/api/*', createBodyCap())

  app.route('/api', healthCheckRouter)

  app.get('/health', c => {
    const health = getHealthService(undefined, cfg)
    return c.json(health, health.status === 'ok' ? 200 : 503)
  })

  return app
}
