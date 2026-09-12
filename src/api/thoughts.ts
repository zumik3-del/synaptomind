import { Hono } from 'hono'
import { parseTags } from '../db/thoughts'
import { withTelemetry } from '../logging'
import type { ThoughtStatus } from '../types/thought'
import { jsonBodyOrDefault } from './utils'
import { runAutoLinkJob } from '../services/auto-link.service'
import { detectEdgeProposals } from '../services/edge-detect.service'
import { getChainService } from '../services/graph.service'
import { getLastSelfImproveStatus, runSelfImproveJob } from '../services/self-improve.service'
import {
  archiveThoughtById,
  bulkCreateThoughtsService,
  createThoughtWithParent,
  getClusterMembersService,
  getThoughtById,
  listThoughtsService,
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

// Read-only: returns scored contradicts/supports candidates; never writes edges.
thoughtsRouter.post('/edge-detect', async c => {
  const body = await jsonBodyOrDefault<{
    project_id?: string
    min_similarity?: number
    max_proposals?: number
  }>(c, {})
  const result = await detectEdgeProposals({
    projectId: body.project_id,
    minSimilarity: body.min_similarity,
    maxProposals: body.max_proposals
  })
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
    return c2.json(getClusterMembersService(c2.req.param('id')!))
  })
})

thoughtsRouter.get('/:id/edges', c => {
  return withTelemetry(c, { action: 'explore', toolName: 'get_chain' }, c2 => {
    const id = c2.req.param('id')!
    const direction = (c2.req.query('direction') || 'both') as 'upstream' | 'downstream' | 'both'
    const result = getChainService(id, direction)
    if (!result) return c2.json({ error: 'Thought not found' }, 404)
    return c2.json(result)
  })
})

thoughtsRouter.get('/:id', c => {
  return withTelemetry(c, { action: 'read', toolName: 'get_thought' }, c2 => {
    const id = c2.req.param('id')!
    const thought = getThoughtById(id)
    if (!thought) return c2.json({ error: 'Not found' }, 404)
    return c2.json(thought)
  })
})

thoughtsRouter.post('/bulk', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'bulk_create_thoughts' }, async c2 => {
    const body = await c2.req.json() as { thoughts?: unknown; project_id?: string }
    const { created, errors } = bulkCreateThoughtsService(body.thoughts as never, body.project_id)
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
      content: string; status?: ThoughtStatus; tags?: string[];
      source?: string; project_id?: string; parent_id?: string; relation?: string; is_profile?: boolean; is_protected?: boolean
    }
    const thought = createThoughtWithParent(
      { content: body.content, status: body.status, tags: body.tags, source: body.source, project_id: body.project_id, is_profile: body.is_profile, is_protected: body.is_protected },
      body.parent_id, body.relation
    )
    return c2.json(thought, 201)
  })
})

thoughtsRouter.put('/:id', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'update_thought' }, async c2 => {
    const id = c2.req.param('id')!
    const body = await c2.req.json() as {
      content?: string; tags?: string[]; status?: ThoughtStatus;
      project_id?: string; is_profile?: boolean; is_protected?: boolean
    }
    const thought = updateThoughtById(id, {
      content: body.content, tags: body.tags, status: body.status, project_id: body.project_id, is_profile: body.is_profile, is_protected: body.is_protected
    })
    if (!thought) return c2.json({ error: 'Not found' }, 404)
    return c2.json(thought)
  })
})

thoughtsRouter.delete('/:id', c => {
  return withTelemetry(c, { action: 'write', toolName: 'archive_thought' }, c2 => {
    const id = c2.req.param('id')!
    const thought = getThoughtById(id)
    if (!thought) return c2.json({ error: 'Not found' }, 404)
    if (thought.status === 'archived') {
      return c2.json(thought)
    }
    const updated = archiveThoughtById(id)
    if (!updated) return c2.json({ error: 'Not found' }, 404)
    return c2.json(updated)
  })
})

export { thoughtsRouter }
