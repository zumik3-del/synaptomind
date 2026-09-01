import { Hono } from 'hono'
import { getFrontier } from '../services/frontier.service'

const frontierRouter = new Hono()

frontierRouter.get('/', c => {
  const projectId = c.req.query('project_id') || undefined
  const k = parseInt(c.req.query('k') || '10', 10) || 10
  return c.json(getFrontier({ project_id: projectId, k }))
})

export { frontierRouter }
