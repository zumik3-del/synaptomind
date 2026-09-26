import { Hono } from 'hono'
import { toEdgeView } from '../db/edges'
import { createEdgeService, deleteEdgeService } from '../services/edges.service'
import { NotFoundError } from '../errors'
import { withTelemetry } from '../logging'

const linksRouter = new Hono()

// Domain errors (EdgeConflictError 409, EdgeAlreadyExistsError 409,
// ClusterEdgeValidationError/SelfLoopEdgeError/InvalidEdgeTypeError/ValidationError
// 400) bubble to the app-level errorHandler, which maps their `statusCode`.
linksRouter.post('/thoughts/:id/link', async c => {
  return withTelemetry(c, { action: 'link', toolName: 'link_thoughts' }, async c2 => {
    const sourceId = c2.req.param('id')!
    const body = await c2.req.json<{ target_id: string; type?: string }>()

    const edge = createEdgeService(sourceId, body.target_id, body.type)
    return c2.json(toEdgeView(edge), 201)
  })
})

linksRouter.delete('/edges/:id', c => {
  return withTelemetry(c, { action: 'link', toolName: 'delete_edge' }, c2 => {
    const removed = deleteEdgeService(c2.req.param('id')!)
    if (!removed) throw new NotFoundError()
    return c2.json({ success: true })
  })
})

export { linksRouter }
