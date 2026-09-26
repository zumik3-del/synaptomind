import { Hono } from 'hono'
import { withTelemetry } from '../logging'
import { getGraphDataService } from '../services/graph.service'

const graphRouter = new Hono()

graphRouter.get('/graph', c => {
  return withTelemetry(c, { action: 'read', toolName: 'get_thought_graph' }, c2 => {
    const project_id = c2.req.query('project_id')
    const status = c2.req.query('status') || 'active'
    if (!['active', 'draft', 'archived', 'all'].includes(status)) {
      return c2.json({ error: 'status must be one of: active, draft, archived, all' }, 400)
    }
    const rawLimit = parseInt(c2.req.query('limit') || '500', 10)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 2000) : 500
    return c2.json(getGraphDataService(project_id, status, limit))
  })
})

export { graphRouter }
