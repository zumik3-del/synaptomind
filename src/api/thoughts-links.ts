import { Hono } from 'hono'
import { withTelemetry } from '../logging'
import {
  deleteThoughtUrlLinkService,
  getThoughtUrlLinksBatchService,
  listThoughtUrlLinksService,
  upsertThoughtUrlLinkService
} from '../services/url_links.service'

const thoughtLinksRouter = new Hono()

thoughtLinksRouter.get('/:id/links', c => {
  return withTelemetry(c, { action: 'read', toolName: 'list_thought_url_links' }, c2 => {
    return c2.json(listThoughtUrlLinksService(c2.req.param('id')!))
  })
})

thoughtLinksRouter.get('/links/batch', c => {
  return withTelemetry(c, { action: 'read', toolName: 'get_thought_url_links_batch' }, c2 => {
    return c2.json(getThoughtUrlLinksBatchService(c2.req.query('ids')))
  })
})

thoughtLinksRouter.post('/:id/links', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'upsert_thought_url_link' }, async c2 => {
    const id = c2.req.param('id')!
    const body = await c2.req.json<{ key: string; url: string; label?: string; sort_order?: number }>()
    return c2.json(upsertThoughtUrlLinkService(id, body), 201)
  })
})

thoughtLinksRouter.delete('/:id/links/:key', c => {
  return withTelemetry(c, { action: 'write', toolName: 'delete_thought_url_link' }, c2 => {
    deleteThoughtUrlLinkService(c2.req.param('id')!, c2.req.param('key')!)
    return c2.json({ success: true })
  })
})

export { thoughtLinksRouter }
