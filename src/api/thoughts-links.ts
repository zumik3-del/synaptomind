import { Hono } from 'hono'
import { getDb } from '../db'
import type { ThoughtUrlLink } from '../db/thought_url_links'
import {
  deleteThoughtUrlLink,
  getThoughtUrlLinks,
  getThoughtUrlLinksForThoughts,
  upsertThoughtUrlLink
} from '../db/thought_url_links'

export const linksRouter = new Hono()

linksRouter.get('/:id/links', c => {
  const db = getDb()
  const id = c.req.param('id')
  return c.json(getThoughtUrlLinks(db, id))
})

linksRouter.get('/links/batch', c => {
  const db = getDb()
  const raw = c.req.query('ids')
  if (!raw) return c.json({ error: 'ids query parameter is required' }, 400)
  const ids = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))].slice(0, 200)
  const map: Record<string, ThoughtUrlLink[]> = {}
  for (const row of getThoughtUrlLinksForThoughts(db, ids)) {
    if (!map[row.thought_id]) map[row.thought_id] = []
    map[row.thought_id].push(row)
  }
  return c.json(map)
})

linksRouter.post('/:id/links', async c => {
  const db = getDb()
  const id = c.req.param('id')
  const body = await c.req.json<{ key: string; url: string; label?: string; sort_order?: number }>()
  if (!body.key || !body.url) return c.json({ error: 'key and url are required' }, 400)
  const key = body.key.trim()
  const link = upsertThoughtUrlLink(db, id, key, body.url, (body.label ?? key).trim(), body.sort_order ?? 0)
  return c.json(link, 201)
})

linksRouter.delete('/:id/links/:key', c => {
  const db = getDb()
  const id = c.req.param('id')
  const key = c.req.param('key')
  const ok = deleteThoughtUrlLink(db, id, key)
  if (!ok) return c.json({ error: 'Not found' }, 404)
  return c.json({ success: true })
})
