import { Hono } from 'hono'
import { toEdgeView } from '../db/edges'
import { createEdgeService, deleteEdgeService } from '../services/edges.service'
import { NotFoundError } from '../errors'

const linksRouter = new Hono()

// Domain errors (EdgeConflictError 409, EdgeAlreadyExistsError 409,
// ClusterEdgeValidationError/SelfLoopEdgeError/InvalidEdgeTypeError/ValidationError
// 400) bubble to the app-level errorHandler, which maps their `statusCode`.
linksRouter.post('/thoughts/:id/link', async c => {
  const sourceId = c.req.param('id')
  const body = await c.req.json<{ target_id: string; type?: string }>()

  const edge = createEdgeService(sourceId, body.target_id, body.type)
  return c.json(toEdgeView(edge), 201)
})

linksRouter.delete('/edges/:id', c => {
  const removed = deleteEdgeService(c.req.param('id'))
  if (!removed) throw new NotFoundError()
  return c.json({ success: true })
})

export { linksRouter }
