import { Hono } from 'hono'
import { withTelemetry } from '../logging'
import { createClusterService } from '../services/cluster.service'

const clusterRouter = new Hono()

clusterRouter.post('/cluster', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'cluster' }, async c2 => {
    const body = await c2.req.json<{
      thought_ids: string[]
      title?: string
      tags?: string[]
      source?: string
      project_id?: string
    }>()

    const result = createClusterService({
      thoughtIds: body.thought_ids,
      title: body.title,
      tags: body.tags,
      source: body.source || 'api',
      projectId: body.project_id
    })
    return c2.json(result, 201)
  })
})

export { clusterRouter }
