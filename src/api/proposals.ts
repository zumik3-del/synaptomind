import { Hono } from 'hono'
import { z } from 'zod/v4'
import { withTelemetry } from '../logging'
import type { ProposalItemKind, ProposalState } from '../db/placement-proposals'
import { ValidationError } from '../errors'
import { PROPOSALS_LIMIT_DEFAULT, proposalsLimitSchema } from '../validation'
import { formatZodIssues, jsonBodyOrDefault } from './utils'
import { applyProposalService } from '../services/placement-apply.service'
import { rollbackService } from '../services/placement-rollback.service'
import { checkDryRunFirst, checkItemGuards, noteDryRun } from '../services/apply-run-guards'
import { enqueueThoughtProposals, listPlacementProposalsService as listProposals, rejectPlacementProposalService as reject } from '../services/placement-proposals.service'

const proposalsRouter = new Hono()

// Shared request contract (audit M8): the `limit` range comes from
// `src/validation.ts`, the same schema `memory_review action=list` advertises, so
// an out-of-range value is a typed 400 instead of a silent service-side clamp.
const proposalsQuerySchema = z.object({
  limit: proposalsLimitSchema.default(PROPOSALS_LIMIT_DEFAULT)
})
const enqueueBodySchema = z.object({ thought_id: z.string().optional(), project_id: z.string().optional(), max_proposals: z.number().int().min(1).optional(), max_items: z.number().int().min(1).optional(), limit: z.number().int().min(1).optional() })
const rollbackBodySchema = z.object({ run_id: z.string().optional(), confirm: z.boolean().optional() })
const applyBodySchema = z.object({ confirm: z.boolean().optional(), run_id: z.string().optional() })

// Read-only: list queued placement proposals (default state=pending).
proposalsRouter.get('/', c => {
  return withTelemetry(c, { action: 'read', toolName: 'list_placement_proposals' }, c2 => {
    const state = c2.req.query('state') as ProposalState | undefined
    const itemKind = c2.req.query('item_kind') as ProposalItemKind | undefined
    const sourceThoughtId = c2.req.query('source_thought_id')
    const parsed = proposalsQuerySchema.safeParse({
      limit: c2.req.query('limit') || undefined
    })
    if (!parsed.success) throw new ValidationError(formatZodIssues(parsed.error))
    return c2.json(listProposals({ state, itemKind, sourceThoughtId, projectId: c2.req.query('project_id'), limit: parsed.data.limit }))
  })
})

// Write: propose a plan for a persisted thought and queue its confirmable items.
proposalsRouter.post('/', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'enqueue_placement_proposals' }, async c2 => {
    const body = await jsonBodyOrDefault<{ thought_id?: string; project_id?: string; max_proposals?: number; max_items?: number; limit?: number }>(c2, {}, enqueueBodySchema)
    if (!body.thought_id) throw new ValidationError('thought_id is required')
    const rows = await enqueueThoughtProposals(body.thought_id, { projectId: body.project_id, maxProposals: body.max_proposals, maxItems: body.max_items, limit: body.limit })
    return c2.json(rows, 201)
  })
})

// Write: roll back every reversible mutation of one explicit run (ADR §2.8).
proposalsRouter.post('/rollback', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'rollback_placement_proposals' }, async c2 => {
    const body = await jsonBodyOrDefault<{ run_id?: string; confirm?: boolean }>(c2, {}, rollbackBodySchema)
    if (!body.run_id) throw new ValidationError('run_id is required')
    return c2.json(rollbackService(body.run_id, { confirm: body.confirm === true, decidedBy: 'api' }))
  })
})

// Write: apply exactly one queued proposal; dry-run unless confirm=true (ADR §2.10.3).
proposalsRouter.post('/:id/apply', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'apply_placement_proposal' }, async c2 => {
    const body = await jsonBodyOrDefault<{ confirm?: boolean; run_id?: string }>(c2, {}, applyBodySchema)
    const proposalId = c2.req.param('id')!
    const confirm = body.confirm === true
    if (confirm) {
      // Same envelope as the MCP surface: a prior preview of the run plus the
      // per-run caps, so the single-item path cannot exceed a run's budget.
      const refusal =
        checkDryRunFirst([proposalId], body.run_id) ?? checkItemGuards(proposalId, { confirm, runId: body.run_id })
      if (refusal) return c2.json({ proposal_id: proposalId, status: 'refused', refusal })
    }
    const result = applyProposalService(proposalId, { confirm, runId: body.run_id, decidedBy: 'api' })
    if (!confirm) noteDryRun([proposalId], body.run_id)
    return c2.json(result)
  })
})

// Write: reject one pending proposal.
proposalsRouter.post('/:id/reject', c => {
  return withTelemetry(c, { action: 'write', toolName: 'reject_placement_proposal' }, c2 => {
    return c2.json(reject(c2.req.param('id')!, { decidedBy: 'api' }))
  })
})

export { proposalsRouter }
