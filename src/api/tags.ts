import { Hono } from 'hono'
import { ValidationError } from '../services/errors'
import { deleteTagService, listTagsService, renameTagService } from '../services/tags.service'

const tagsRouter = new Hono()

tagsRouter.get('/', c => {
  const q = c.req.query('q')
  return c.json(listTagsService(q))
})

tagsRouter.put('/:id', async c => {
  const body = await c.req.json<{ name: string }>()
  try {
    const tag = renameTagService(c.req.param('id'), body.name)
    if (!tag) return c.json({ error: 'Tag not found' }, 404)
    return c.json(tag)
  } catch (err: unknown) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400)
    throw err
  }
})

tagsRouter.delete('/:id', c => {
  const deleted = deleteTagService(c.req.param('id'))
  if (!deleted) return c.json({ error: 'Tag not found' }, 404)
  return c.json({ success: true })
})

export { tagsRouter }
