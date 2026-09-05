import { Hono } from 'hono'
import { getClusterMembers } from '../db/edges'
import { getDb } from '../db'
import { parseTags } from '../db/thoughts'
import { withTelemetry } from '../logging'
import { jsonBodyOrDefault } from './utils'
import { runAutoLinkJob } from '../services/auto-link.service'
import { getChainService } from '../services/graph.service'
import { getLastSelfImproveStatus, runSelfImproveJob } from '../services/self-improve.service'
import {
  archiveThoughtById,
  createThoughtWithParent,
  deleteThoughtById,
  getThoughtById,
  listThoughtsService,
  pruneThoughtUrlLinksService,
  updateThoughtById
} from '../services/thoughts.service'
import { thoughtLinksRouter } from './thoughts-links'
import { mergeRouter } from './thoughts-merge'
import { searchRouter } from './thoughts-search'

const thoughtsRouter = new Hono()

thoughtsRouter.route('/', searchRouter)
thoughtsRouter.route('/', thoughtLinksRouter)
thoughtsRouter.route('/', mergeRouter)

thoughtsRouter.get('/timeline', c => {
  return withTelemetry(c, { action: 'read', toolName: 'get_thought_timeline' }, c2 => {
    const status = c2.req.query('status')
    const project_id = c2.req.query('project_id')
    const tag = c2.req.query('tag')
    const limit = parseInt(c2.req.query('limit') || '50', 10)
    const offset = parseInt(c2.req.query('offset') || '0', 10)
    const thoughts = listThoughtsService({ status, project_id, tag: parseTags(tag)?.join(','), limit, offset })
    return c2.json(thoughts)
  })
})

thoughtsRouter.post('/auto-link', async c => {
  const body = await jsonBodyOrDefault<{ dry_run?: boolean; max_edges?: number }>(c, {})
  const result = await runAutoLinkJob({ dryRun: body.dry_run ?? false, maxEdgesPerRun: body.max_edges ?? undefined })
  return c.json(result)
})

thoughtsRouter.post('/self-improve/run', async c => {
  const body = await jsonBodyOrDefault<{ dry_run?: boolean }>(c, {})
  const result = await runSelfImproveJob({ dryRun: body.dry_run ?? false })
  return c.json(result)
})

thoughtsRouter.get('/self-improve/status', c => {
  return c.json(getLastSelfImproveStatus())
})

thoughtsRouter.get('/members/:id', c => {
  return withTelemetry(c, { action: 'read', toolName: 'get_thought' }, c2 => {
    const id = c2.req.param('id')
    const cluster = getThoughtById(id)
    if (!cluster) return c2.json({ error: 'Not found' }, 404)
    if (!cluster.is_cluster) return c2.json({ error: 'Not a cluster thought' }, 400)
    const members = getClusterMembers(getDb(), id)
    return c2.json({ cluster, members })
  })
})

thoughtsRouter.get('/:id/edges', c => {
  return withTelemetry(c, { action: 'explore', toolName: 'get_chain' }, c2 => {
    const id = c2.req.param('id')
    const direction = (c2.req.query('direction') || 'both') as 'upstream' | 'downstream' | 'both'
    const result = getChainService(id, direction)
    if (!result) return c2.json({ error: 'Thought not found' }, 404)
    return c2.json(result)
  })
})

thoughtsRouter.get('/:id', c => {
  return withTelemetry(c, { action: 'read', toolName: 'get_thought' }, c2 => {
    const id = c2.req.param('id')
    const thought = getThoughtById(id)
    if (!thought) return c2.json({ error: 'Not found' }, 404)
    return c2.json(thought)
  })
})

thoughtsRouter.post('/bulk', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'bulk_create_thoughts' }, async c2 => {
    const body = await c2.req.json() as {
      thoughts: Array<{
        content: string; status?: 'draft' | 'active' | 'archived'; tags?: string[];
        source?: string; project_id?: string; parent_id?: string; relation?: string; is_profile?: boolean
      }>; project_id?: string
    }
    if (!Array.isArray(body.thoughts) || body.thoughts.length === 0) {
      return c2.json({ error: 'thoughts array is required and must not be empty' }, 400)
    }
    if (body.thoughts.length > 10000) {
      return c2.json({ error: 'Maximum 10000 thoughts per bulk request' }, 400)
    }

    const d = getDb()
    const created: Array<{ index: number; thought: ReturnType<typeof createThoughtWithParent> }> = []
    const errors: Array<{ index: number; error: string }> = []

    const run = d.transaction(() => {
      for (let i = 0; i < body.thoughts.length; i++) {
        const t = body.thoughts[i]
        try {
          const projectId = t.project_id ?? body.project_id
          const thought = createThoughtWithParent(
            { content: t.content, status: t.status, tags: t.tags, source: t.source, project_id: projectId, is_profile: t.is_profile },
            t.parent_id, t.relation
          )
          created.push({ index: i, thought })
        } catch (err) {
          errors.push({ index: i, error: err instanceof Error ? err.message : String(err) })
        }
      }
    })
    run()

    return c2.json({
      created: created.length,
      errors: errors.length,
      thoughts: created.map(c => c.thought),
      error_details: errors.length > 0 ? errors : undefined
    }, 201)
  })
})

thoughtsRouter.post('/', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'create_thought' }, async c2 => {
    const body = await c2.req.json() as {
      content: string; status?: 'draft' | 'active' | 'archived'; tags?: string[];
      source?: string; project_id?: string; parent_id?: string; relation?: string; is_profile?: boolean
    }
    const thought = createThoughtWithParent(
      { content: body.content, status: body.status, tags: body.tags, source: body.source, project_id: body.project_id, is_profile: body.is_profile },
      body.parent_id, body.relation
    )
    return c2.json(thought, 201)
  })
})

thoughtsRouter.put('/:id', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'update_thought' }, async c2 => {
    const id = c2.req.param('id')
    const body = await c2.req.json() as {
      content?: string; tags?: string[]; status?: 'draft' | 'active' | 'archived';
      project_id?: string; is_profile?: boolean
    }
    const thought = updateThoughtById(id, {
      content: body.content, tags: body.tags, status: body.status, project_id: body.project_id, is_profile: body.is_profile
    })
    if (thought && body.content !== undefined) {
      pruneThoughtUrlLinksService(id, body.content)
    }
    if (!thought) return c2.json({ error: 'Not found' }, 404)
    return c2.json(thought)
  })
})

thoughtsRouter.delete('/:id', c => {
  return withTelemetry(c, { action: 'write', toolName: 'archive_thought' }, c2 => {
    const id = c2.req.param('id')
    const thought = getThoughtById(id)
    if (!thought) return c2.json({ error: 'Not found' }, 404)
    if (thought.status === 'archived') {
      deleteThoughtById(id)
      return c2.json({ success: true })
    }
    const updated = archiveThoughtById(id)
    if (!updated) return c2.json({ error: 'Not found' }, 404)
    return c2.json(updated)
  })
})

export { thoughtsRouter }
