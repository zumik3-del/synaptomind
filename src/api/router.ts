import { Hono } from 'hono'
import { getHealthService } from '../services/health.service'
import { authMiddleware } from './middleware/auth'
import { rateLimitMiddleware } from './middleware/rate-limit'
import { errorHandler } from './middleware/error-handler'
import { autoClusterRouter } from './auto-cluster'
import { clusterRouter } from './cluster'
import { crystalsRouter } from './crystals'
import { frontierRouter } from './frontier'
import { graphRouter } from './graph'
import { linksRouter } from './links'
import { primersRouter } from './primers'
import { profileRouter } from './profile'
import { projectsRouter } from './projects'
import { settingsRouter } from './settings'
import { slotsRouter } from './slots'
import { smartNotesRouter } from './smart-notes'
import { statsRouter } from './stats'
import { tagsRouter } from './tags'
import { telemetryRouter } from './telemetry'
import { thoughtVerifyRouter } from './thought-verify'
import { thoughtsRouter } from './thoughts'
import { healthCheckRouter } from './health-check'

export function createApp(): Hono {
  const app = new Hono()

  app.onError(errorHandler)
  app.use('/api/*', authMiddleware)
  app.use('/api/*', rateLimitMiddleware)

  app.use('/api/*', async (c, next) => {
    const contentLength = parseInt(c.req.header('content-length') || '0', 10)
    if (contentLength > 5_242_880) {
      return c.json({ error: 'Request body too large (max 5MB)' }, 413)
    }
    return next()
  })

  app.route('/api/thoughts', thoughtsRouter)
  app.route('/api/tags', tagsRouter)
  app.route('/api', linksRouter)
  app.route('/api', graphRouter)
  app.route('/api', clusterRouter)
  app.route('/api/projects', projectsRouter)
  app.route('/api/primers', primersRouter)
  app.route('/api/thought-verify', thoughtVerifyRouter)
  app.route('/api', settingsRouter)
  app.route('/api', statsRouter)
  app.route('/api/telemetry', telemetryRouter)
  app.route('/api/smart-notes', smartNotesRouter)
  app.route('/api/profile', profileRouter)
  app.route('/api/slots', slotsRouter)
  app.route('/api/crystals', crystalsRouter)
  app.route('/api/frontier', frontierRouter)
  app.route('/api', autoClusterRouter)
  app.route('/api', healthCheckRouter)

  app.get('/health', c => {
    const health = getHealthService()
    return c.json(health, health.status === 'ok' ? 200 : 503)
  })

  return app
}
