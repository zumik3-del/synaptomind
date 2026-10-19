import { Hono } from 'hono'
import { z } from 'zod/v4'
import { withTelemetry } from '../logging'
import { requiredJsonBody } from './utils'
import { getMergePreviewService, mergeThoughtsService } from '../services/merge.service'

const mergeRouter = new Hono()

// Shared body helper (audit M8): a malformed payload and a schema mismatch both
// map to a typed 400 instead of a `SyntaxError` → 500 from raw `c.req.json()`.
const mergeBodySchema = z.object({
  source_id: z.string().min(1, 'source_id is required'),
  merged_content: z.string().optional(),
  merged_tags: z.array(z.string()).optional(),
  project_id: z.string().optional()
})

mergeRouter.post('/:targetId/merge', async c => {
  return withTelemetry(c, { action: 'link', toolName: 'merge_thoughts' }, async c2 => {
    const targetId = c2.req.param('targetId')!
    const body = await requiredJsonBody(c2, mergeBodySchema)

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
