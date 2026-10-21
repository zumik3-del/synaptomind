import { Hono } from 'hono'
import { createClusterService } from '../services/cluster.service'

const clusterRouter = new Hono()

clusterRouter.post('/cluster', async c => {
  const body = await c.req.json<{
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
  return c.json(result, 201)
})

export { clusterRouter }
