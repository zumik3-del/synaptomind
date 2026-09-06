import { Hono } from 'hono'
import {
  deleteThoughtUrlLinkService,
  getThoughtUrlLinksBatchService,
  listThoughtUrlLinksService,
  upsertThoughtUrlLinkService
} from '../services/url_links.service'

const thoughtLinksRouter = new Hono()

thoughtLinksRouter.get('/:id/links', c => {
  return c.json(listThoughtUrlLinksService(c.req.param('id')))
})

thoughtLinksRouter.get('/links/batch', c => {
  return c.json(getThoughtUrlLinksBatchService(c.req.query('ids')))
})

thoughtLinksRouter.post('/:id/links', async c => {
  const id = c.req.param('id')
  const body = await c.req.json<{ key: string; url: string; label?: string; sort_order?: number }>()
  return c.json(upsertThoughtUrlLinkService(id, body), 201)
})

thoughtLinksRouter.delete('/:id/links/:key', c => {
  deleteThoughtUrlLinkService(c.req.param('id'), c.req.param('key'))
  return c.json({ success: true })
})

export { thoughtLinksRouter }
