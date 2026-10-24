import { Hono } from 'hono'
import { z } from 'zod/v4'
import type { ProposalState, StoredProposalItemKind } from '../db/placement-proposals'
import { ValidationError } from '../errors'
import { PROPOSALS_LIMIT_DEFAULT, proposalsLimitSchema } from '../validation'
import { formatZodIssues, jsonBodyOrDefault } from './utils'
import { applyProposalService } from '../services/placement-apply.service'
import { rollbackService } from '../services/placement-rollback.service'
import { enqueueThoughtProposals, listPlacementProposalsService as listProposals, rejectPlacementProposalService as reject } from '../services/placement-proposals.service'

const proposalsRouter = new Hono()

// Shared request contract (audit M8): the `limit` range comes from
// `src/validation.ts`, the same schema `edge_review action=list` advertises, so
// an out-of-range value is a typed 400 instead of a silent service-side clamp.
const proposalsQuerySchema = z.object({
  limit: proposalsLimitSchema.default(PROPOSALS_LIMIT_DEFAULT)
})
// Enqueue accepts the canonical cap only: `max_items` and `limit` are retired,
// so they fail the schema with a typed 400 naming `max_proposals` (same
// tombstone pattern as the retired is_profile flag) instead of being dropped.
const enqueueBodySchema = z.object({ thought_id: z.string().optional(), project_id: z.string().optional(), max_proposals: z.number().int().min(1).optional(), max_items: z.never({ error: 'max_items was removed; use max_proposals' }).optional(), limit: z.never({ error: 'limit was removed; use max_proposals' }).optional() })
const rollbackBodySchema = z.object({ run_id: z.string().optional(), confirm: z.boolean().optional() })
const applyBodySchema = z.object({ confirm: z.boolean().optional(), run_id: z.string().optional() })

// Read-only: list queued placement proposals (default state=pending).
proposalsRouter.get('/', c => {
  const state = c.req.query('state') as ProposalState | undefined
  // A removed kind (`placement`/`lifecycle`/`triage_*`) still filters: rows of
  // those kinds stay readable in older installs (tasks #1942, #1946).
  const itemKind = c.req.query('item_kind') as StoredProposalItemKind | undefined
  const sourceThoughtId = c.req.query('source_thought_id')
  const createdAfter = c.req.query('created_after')
  const includeRetired = c.req.query('include_retired') === 'true'
  const parsed = proposalsQuerySchema.safeParse({
    limit: c.req.query('limit') || undefined
  })
  if (!parsed.success) throw new ValidationError(formatZodIssues(parsed.error))
  return c.json(listProposals({ state, itemKind, sourceThoughtId, createdAfter, projectId: c.req.query('project_id'), limit: parsed.data.limit, includeRetired }))
})

// Write: propose a plan for a persisted thought and queue its confirmable items.
// The response reports the queued rows AND the plan items that were skipped
// because their kind is no longer supported (task #1942).
proposalsRouter.post('/', async c => {
  const body = await jsonBodyOrDefault<{ thought_id?: string; project_id?: string; max_proposals?: number }>(c, {}, enqueueBodySchema)
  if (!body.thought_id) throw new ValidationError('thought_id is required')
  // Only the canonical cap is forwarded: the retired aliases were rejected by
  // the schema above, and the service is not re-informed of them here.
  const outcome = await enqueueThoughtProposals(body.thought_id, { projectId: body.project_id, maxProposals: body.max_proposals })
  return c.json(outcome, 201)
})

// Write: roll back every reversible mutation of one explicit run (ADR §2.8).
proposalsRouter.post('/rollback', async c => {
  const body = await jsonBodyOrDefault<{ run_id?: string; confirm?: boolean }>(c, {}, rollbackBodySchema)
  if (!body.run_id) throw new ValidationError('run_id is required')
  return c.json(rollbackService(body.run_id, { confirm: body.confirm === true, decidedBy: 'api' }))
})

// Write: apply exactly one queued proposal; dry-run unless confirm=true (ADR §2.10.3).
proposalsRouter.post('/:id/apply', async c => {
  const body = await jsonBodyOrDefault<{ confirm?: boolean; run_id?: string }>(c, {}, applyBodySchema)
  const proposalId = c.req.param('id')!
  return c.json(
    applyProposalService(proposalId, { confirm: body.confirm === true, runId: body.run_id, decidedBy: 'api' })
  )
})

// Write: reject one pending proposal.
proposalsRouter.post('/:id/reject', c => {
  return c.json(reject(c.req.param('id')!, { decidedBy: 'api' }))
})

export { proposalsRouter }
