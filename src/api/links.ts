import { Hono } from 'hono'
import { toEdgeView, EdgeAlreadyExistsError } from '../db/edges'
import { createEdgeService, deleteEdgeService } from '../services/edges.service'

const linksRouter = new Hono()

linksRouter.post('/thoughts/:id/link', async c => {
  const sourceId = c.req.param('id')
  const body = await c.req.json<{ target_id: string; type?: string }>()

  try {
    const edge = createEdgeService(sourceId, body.target_id, body.type)
    return c.json(toEdgeView(edge), 201)
  } catch (err: unknown) {
    if (err instanceof EdgeAlreadyExistsError) {
      return c.json({ error: err.message }, 409)
    }
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: msg }, 400)
  }
})

linksRouter.delete('/edges/:id', c => {
  const removed = deleteEdgeService(c.req.param('id'))
  if (!removed) return c.json({ error: 'Not found' }, 404)
  return c.json({ success: true })
})

export { linksRouter }
