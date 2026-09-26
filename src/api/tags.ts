import { Hono } from 'hono'
import { NotFoundError } from '../errors'
import { withTelemetry } from '../logging'
import { deleteTagService, listTagsService, renameTagService } from '../services/tags.service'

const tagsRouter = new Hono()

tagsRouter.get('/', c => {
  return withTelemetry(c, { action: 'read', toolName: 'list_tags' }, c2 => {
    const q = c2.req.query('q')
    return c2.json(listTagsService(q))
  })
})

tagsRouter.put('/:id', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'rename_tag' }, async c2 => {
    const body = await c2.req.json<{ name: string }>()
    const tag = renameTagService(c2.req.param('id')!, body.name)
    if (!tag) throw new NotFoundError('Tag not found')
    return c2.json(tag)
  })
})

tagsRouter.delete('/:id', c => {
  return withTelemetry(c, { action: 'write', toolName: 'delete_tag' }, c2 => {
    const deleted = deleteTagService(c2.req.param('id')!)
    if (!deleted) throw new NotFoundError('Tag not found')
    return c2.json({ success: true })
  })
})

export { tagsRouter }
