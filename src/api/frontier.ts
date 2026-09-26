import { Hono } from 'hono'
import { withTelemetry } from '../logging'
import { getFrontier } from '../services/frontier.service'

const frontierRouter = new Hono()

frontierRouter.get('/', c => {
  return withTelemetry(c, { action: 'read', toolName: 'get_frontier' }, c2 => {
    const projectId = c2.req.query('project_id') || undefined
    const k = parseInt(c2.req.query('k') || '10', 10) || 10
    return c2.json(getFrontier({ project_id: projectId, k }))
  })
})

export { frontierRouter }
