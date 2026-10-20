import { Hono } from 'hono'
import { z } from 'zod/v4'
import { withTelemetry } from '../logging'
import { ValidationError } from '../errors'
import { parseTags } from '../utils'
import { TIMELINE_LIMIT_DEFAULT, thoughtStatusSchema, timelineLimitSchema } from '../validation'
import { formatZodIssues, jsonBodyOrDefault, requiredJsonBody } from './utils'
import { runAutoLinkJob } from '../services/auto-link.service'
import { detectEdgeProposals } from '../services/edge-detect.service'
import { proposePlacementPlan } from '../services/placement/engine'
import { getChainService } from '../services/graph.service'
import { getLastSelfImproveStatus, runSelfImproveJob } from '../services/self-improve.service'
import {
  archiveThoughtByIdService,
  createThoughtWithParentService,
  getClusterMembersService,
  getThoughtByIdService,
  listThoughtsService,
  updateThoughtByIdService
} from '../services/thoughts.service'
import { bulkCreateThoughtsService, type BulkCreateItem } from '../services/bulk.service'
import { thoughtLinksRouter } from './thoughts-links'
import { mergeRouter } from './thoughts-merge'
import { searchRouter } from './thoughts-search'

const thoughtsRouter = new Hono()

thoughtsRouter.route('/', searchRouter)
thoughtsRouter.route('/', thoughtLinksRouter)
thoughtsRouter.route('/', mergeRouter)

// Request contract for the thought surface (audit M8). The status enum and the
// timeline limit range come from `src/validation.ts`, shared with MCP.
const timelineQuerySchema = z.object({
  status: thoughtStatusSchema.optional(),
  limit: timelineLimitSchema.default(TIMELINE_LIMIT_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0)
})

const createThoughtBodySchema = z.object({
  content: z.string().min(1, 'content is required'),
  status: thoughtStatusSchema.optional(),
  tags: z.array(z.string()).optional(),
  source: z.string().optional(),
  project_id: z.string().optional(),
  parent_id: z.string().optional(),
  relation: z.string().optional(),
  is_profile: z.boolean().optional(),
  is_protected: z.boolean().optional()
})

const updateThoughtBodySchema = z.object({
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  tags_mode: z.enum(['replace', 'merge']).optional(),
  status: thoughtStatusSchema.optional(),
  project_id: z.string().optional(),
  is_profile: z.boolean().optional(),
  is_protected: z.boolean().optional()
})

const bulkCreateBodySchema = z.object({
  thoughts: z.array(z.unknown()).optional(),
  project_id: z.string().optional()
})
const autoLinkBodySchema = z.object({ dry_run: z.boolean().optional(), max_edges: z.number().int().min(1).optional() })
const edgeDetectBodySchema = z.object({ project_id: z.string().optional(), min_similarity: z.number().finite().min(0).max(1).optional(), max_proposals: z.number().int().min(1).optional() })
const proposeBodySchema = z.object({ thought_id: z.string().optional(), content: z.string().optional(), project_id: z.string().optional() })
const selfImproveBodySchema = z.object({ dry_run: z.boolean().optional() })

thoughtsRouter.get('/timeline', c => {
  return withTelemetry(c, { action: 'read', toolName: 'get_thought_timeline' }, c2 => {
    const parsed = timelineQuerySchema.safeParse({
      status: c2.req.query('status') || undefined,
      limit: c2.req.query('limit') || undefined,
      offset: c2.req.query('offset') || undefined
    })
    if (!parsed.success) throw new ValidationError(formatZodIssues(parsed.error))
    const project_id = c2.req.query('project_id')
    const tag = c2.req.query('tag')
    const thoughts = listThoughtsService({
      status: parsed.data.status,
      project_id,
      tag: parseTags(tag)?.join(','),
      limit: parsed.data.limit,
      offset: parsed.data.offset
    })
    return c2.json(thoughts)
  })
})

thoughtsRouter.post('/auto-link', async c => {
  return withTelemetry(c, { action: 'link', toolName: 'auto_link' }, async c2 => {
    const body = await jsonBodyOrDefault<{ dry_run?: boolean; max_edges?: number }>(c2, {}, autoLinkBodySchema)
    const result = await runAutoLinkJob({ dryRun: body.dry_run ?? false, maxEdgesPerRun: body.max_edges ?? undefined })
    return c2.json(result)
  })
})

// Read-only: returns unconfirmed `related` candidate pairs (similarity-only); never writes edges.
thoughtsRouter.post('/edge-detect', async c => {
  return withTelemetry(c, { action: 'read', toolName: 'edge_suggestions' }, async c2 => {
    const body = await jsonBodyOrDefault<{
      project_id?: string
      min_similarity?: number
      max_proposals?: number
    }>(c2, {}, edgeDetectBodySchema)
    const result = await detectEdgeProposals({
      projectId: body.project_id,
      minSimilarity: body.min_similarity,
      maxProposals: body.max_proposals
    })
    return c2.json(result)
  })
})

// Read-only: returns one placement/link plan for a thought (or draft); never writes.
thoughtsRouter.post('/propose', async c => {
  return withTelemetry(c, { action: 'read', toolName: 'propose_placement' }, async c2 => {
    const body = await jsonBodyOrDefault<{
      thought_id?: string
      content?: string
      project_id?: string
    }>(c2, {}, proposeBodySchema)
    const result = await proposePlacementPlan(
      { thoughtId: body.thought_id, content: body.content, projectId: body.project_id },
      { projectId: body.project_id }
    )
    return c2.json(result)
  })
})

thoughtsRouter.post('/self-improve/run', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'self_improve' }, async c2 => {
    const body = await jsonBodyOrDefault<{ dry_run?: boolean }>(c2, {}, selfImproveBodySchema)
    const result = await runSelfImproveJob({ dryRun: body.dry_run ?? false })
    return c2.json(result)
  })
})

thoughtsRouter.get('/self-improve/status', c => {
  return withTelemetry(c, { action: 'read', toolName: 'self_improve_status' }, c2 => {
    return c2.json(getLastSelfImproveStatus())
  })
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
    const thought = getThoughtByIdService(id)
    if (!thought) return c2.json({ error: 'Not found' }, 404)
    return c2.json(thought)
  })
})

thoughtsRouter.post('/bulk', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'bulk_create_thoughts' }, async c2 => {
    const body = await requiredJsonBody(c2, bulkCreateBodySchema)
    const { created, errors } = bulkCreateThoughtsService(body.thoughts as BulkCreateItem[] | undefined, body.project_id)
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
    const body = await requiredJsonBody(c2, createThoughtBodySchema)
    const thought = createThoughtWithParentService(
      { content: body.content, status: body.status, tags: body.tags, source: body.source, project_id: body.project_id, is_profile: body.is_profile, is_protected: body.is_protected },
      body.parent_id, body.relation
    )
    return c2.json(thought, 201)
  })
})

thoughtsRouter.put('/:id', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'update_thought' }, async c2 => {
    const id = c2.req.param('id')!
    const body = await requiredJsonBody(c2, updateThoughtBodySchema)
    const thought = updateThoughtByIdService(id, {
      content: body.content, tags: body.tags, tags_mode: body.tags_mode, status: body.status, project_id: body.project_id, is_profile: body.is_profile, is_protected: body.is_protected
    })
    if (!thought) return c2.json({ error: 'Not found' }, 404)
    return c2.json(thought)
  })
})

thoughtsRouter.delete('/:id', c => {
  return withTelemetry(c, { action: 'write', toolName: 'archive_thought' }, c2 => {
    const id = c2.req.param('id')!
    const thought = getThoughtByIdService(id)
    if (!thought) return c2.json({ error: 'Not found' }, 404)
    if (thought.status === 'archived') {
      return c2.json(thought)
    }
    const updated = archiveThoughtByIdService(id)
    if (!updated) return c2.json({ error: 'Not found' }, 404)
    return c2.json(updated)
  })
})

export { thoughtsRouter }
