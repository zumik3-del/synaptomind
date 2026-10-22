import { Hono } from 'hono'
import { getStatsService } from '../services/stats.service'

// /api/stats is a pure infrastructure aggregate (DB size and counts), not a
// memory operation.
const statsRouter = new Hono()

statsRouter.get('/stats', c => {
  return c.json(getStatsService())
})

export { statsRouter }
