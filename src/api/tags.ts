import { Hono } from 'hono'
import { NotFoundError, ValidationError } from '../errors'
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
    if (!tag) throw new NotFoundError('Tag not found')
    return c.json(tag)
  } catch (err: unknown) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400)
    throw err
  }
})

tagsRouter.delete('/:id', c => {
  const deleted = deleteTagService(c.req.param('id'))
  if (!deleted) throw new NotFoundError('Tag not found')
  return c.json({ success: true })
})

export { tagsRouter }
