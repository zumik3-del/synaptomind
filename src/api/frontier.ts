import { Hono } from 'hono'
import { getFrontierService } from '../services/frontier.service'

const frontierRouter = new Hono()

frontierRouter.get('/', c => {
  const projectId = c.req.query('project_id') || undefined
  const rawK = c.req.query('k')
  const k = rawK ? parseInt(rawK, 10) : 10
  if (!Number.isFinite(k) || k <= 0) return c.json({ error: 'invalid k' }, 400)
  return c.json(getFrontierService({ project_id: projectId, k }))
})

export { frontierRouter }
