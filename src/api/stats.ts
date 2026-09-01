import { Hono } from 'hono'
import { getStatsService } from '../services/stats.service'

const statsRouter = new Hono()

statsRouter.get('/stats', c => {
  return c.json(getStatsService())
})

export { statsRouter }
