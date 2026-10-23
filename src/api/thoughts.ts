import { Hono } from 'hono'
import { z } from 'zod/v4'
import { ValidationError } from '../errors'
import { parseTags } from '../utils'
import { TIMELINE_LIMIT_DEFAULT, thoughtStatusSchema, timelineLimitSchema } from '../validation'
import { formatZodIssues, jsonBodyOrDefault, requiredJsonBody } from './utils'
import { proposePlacementPlan } from '../services/placement/engine'
import { getChainService } from '../services/graph.service'
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
import { retentionReviewRouter } from './retention-review'
import { searchRouter } from './thoughts-search'

const thoughtsRouter = new Hono()

thoughtsRouter.route('/', searchRouter)
thoughtsRouter.route('/', thoughtLinksRouter)
thoughtsRouter.route('/', mergeRouter)
thoughtsRouter.route('/', retentionReviewRouter)

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
  // Retired with the profile surface (task #1939): the flag is no longer a
  // writer, so an explicit one is refused instead of silently ignored.
  is_profile: z.never({ error: 'is_profile is retired' }).optional(),
  is_protected: z.boolean().optional()
})

const updateThoughtBodySchema = z.object({
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  tags_mode: z.enum(['replace', 'merge']).optional(),
  status: thoughtStatusSchema.optional(),
  project_id: z.string().optional(),
  is_profile: z.never({ error: 'is_profile is retired' }).optional(),
  is_protected: z.boolean().optional(),
  surface_after: z.string().nullable().optional()
})

const bulkCreateBodySchema = z.object({
  thoughts: z.array(z.unknown()).optional(),
  project_id: z.string().optional()
})
const proposeBodySchema = z.object({ thought_id: z.string().optional(), content: z.string().optional(), project_id: z.string().optional() })

thoughtsRouter.get('/timeline', c => {
  const parsed = timelineQuerySchema.safeParse({
    status: c.req.query('status') || undefined,
    limit: c.req.query('limit') || undefined,
    offset: c.req.query('offset') || undefined
  })
  if (!parsed.success) throw new ValidationError(formatZodIssues(parsed.error))
  const project_id = c.req.query('project_id')
  const tag = c.req.query('tag')
  const thoughts = listThoughtsService({
    status: parsed.data.status,
    project_id,
    tag: parseTags(tag)?.join(','),
    limit: parsed.data.limit,
    offset: parsed.data.offset
  })
  return c.json(thoughts)
})

// Read-only: returns one placement/link plan for a thought (or draft); never writes.
thoughtsRouter.post('/propose', async c => {
  const body = await jsonBodyOrDefault<{
    thought_id?: string
    content?: string
    project_id?: string
  }>(c, {}, proposeBodySchema)
  const result = await proposePlacementPlan(
    { thoughtId: body.thought_id, content: body.content, projectId: body.project_id },
    { projectId: body.project_id }
  )
  return c.json(result)
})

thoughtsRouter.get('/members/:id', c => {
  return c.json(getClusterMembersService(c.req.param('id')!))
})

thoughtsRouter.get('/:id/edges', c => {
  const id = c.req.param('id')!
  const direction = (c.req.query('direction') || 'both') as 'upstream' | 'downstream' | 'both'
  const result = getChainService(id, direction)
  if (!result) return c.json({ error: 'Thought not found' }, 404)
  return c.json(result)
})

thoughtsRouter.get('/:id', c => {
  const id = c.req.param('id')!
  const thought = getThoughtByIdService(id)
  if (!thought) return c.json({ error: 'Not found' }, 404)
  return c.json(thought)
})

thoughtsRouter.post('/bulk', async c => {
  const body = await requiredJsonBody(c, bulkCreateBodySchema)
  const { created, errors } = bulkCreateThoughtsService(body.thoughts as BulkCreateItem[] | undefined, body.project_id)
  return c.json({
    created: created.length,
    errors: errors.length,
    thoughts: created.map(item => item.thought),
    error_details: errors.length > 0 ? errors : undefined
  }, 201)
})

thoughtsRouter.post('/', async c => {
  const body = await requiredJsonBody(c, createThoughtBodySchema)
  const thought = createThoughtWithParentService(
    { content: body.content, status: body.status, tags: body.tags, source: body.source, project_id: body.project_id, is_protected: body.is_protected },
    body.parent_id, body.relation
  )
  return c.json(thought, 201)
})

thoughtsRouter.put('/:id', async c => {
  const id = c.req.param('id')!
  const body = await requiredJsonBody(c, updateThoughtBodySchema)
  const thought = updateThoughtByIdService(id, {
    content: body.content, tags: body.tags, tags_mode: body.tags_mode, status: body.status, project_id: body.project_id, is_protected: body.is_protected, surface_after: body.surface_after
  })
  if (!thought) return c.json({ error: 'Not found' }, 404)
  return c.json(thought)
})

thoughtsRouter.delete('/:id', c => {
  const id = c.req.param('id')!
  const thought = getThoughtByIdService(id)
  if (!thought) return c.json({ error: 'Not found' }, 404)
  if (thought.status === 'archived') {
    return c.json(thought)
  }
  const updated = archiveThoughtByIdService(id)
  if (!updated) return c.json({ error: 'Not found' }, 404)
  return c.json(updated)
})

export { thoughtsRouter }
