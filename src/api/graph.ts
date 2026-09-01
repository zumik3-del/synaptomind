import { Hono } from 'hono'
import { getGraphDataService } from '../services/graph.service'

const graphRouter = new Hono()

graphRouter.get('/graph', c => {
  const project_id = c.req.query('project_id')
  const status = c.req.query('status') || 'active'
  if (!['active', 'draft', 'archived', 'all'].includes(status)) {
    return c.json({ error: 'status must be one of: active, draft, archived, all' }, 400)
  }
  const rawLimit = parseInt(c.req.query('limit') || '500', 10)
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 2000) : 500
  return c.json(getGraphDataService(project_id, status, limit))
})

export { graphRouter }
