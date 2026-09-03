import { Hono } from 'hono'
import { getEdgesForThought, toEdgeView } from '../db/edges'
import { getDb } from '../db'
import { withTelemetry } from '../logging'
import { getThoughtById, mergeThoughtsService } from '../services/thoughts.service'

const mergeRouter = new Hono()

mergeRouter.post('/:targetId/merge', async c => {
  return withTelemetry(c, { action: 'link', toolName: 'merge_thoughts' }, async c2 => {
    const targetId = c2.req.param('targetId')
    const body = await c2.req.json() as {
      source_id: string
      merged_content?: string
      merged_tags?: string[]
      project_id?: string
    }

    if (!body.merged_content && body.merged_tags === undefined && body.project_id === undefined) {
      const source = getThoughtById(body.source_id)
      const target = getThoughtById(targetId)
      if (!source || !target) return c2.json({ error: 'Thought not found' }, 404)
      return c2.json({
        mode: 'preview',
        source: { ...source, edges: getEdgesForThought(getDb(), body.source_id).map(toEdgeView) },
        target
      })
    }

    const result = mergeThoughtsService(targetId, body.source_id, body.merged_content, body.merged_tags, body.project_id)
    return c2.json(result)
  })
})

export { mergeRouter }
