import { Hono } from 'hono'
import { withTelemetry } from '../logging'
import { getMergePreviewService, mergeThoughtsService } from '../services/thoughts.service'

const mergeRouter = new Hono()

mergeRouter.post('/:targetId/merge', async c => {
  return withTelemetry(c, { action: 'link', toolName: 'merge_thoughts' }, async c2 => {
    const targetId = c2.req.param('targetId')!
    const body = await c2.req.json() as {
      source_id: string
      merged_content?: string
      merged_tags?: string[]
      project_id?: string
    }

    if (!body.merged_content && body.merged_tags === undefined && body.project_id === undefined) {
      const preview = getMergePreviewService(body.source_id, targetId)
      if (!preview) return c2.json({ error: 'Thought not found' }, 404)
      return c2.json(preview)
    }

    const result = mergeThoughtsService({ targetId, sourceId: body.source_id, mergedContent: body.merged_content, mergedTags: body.merged_tags, projectId: body.project_id })
    return c2.json(result)
  })
})

export { mergeRouter }
