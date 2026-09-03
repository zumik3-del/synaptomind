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
