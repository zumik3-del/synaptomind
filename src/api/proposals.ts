import { Hono } from 'hono'
import { withTelemetry } from '../logging'
import type { ProposalItemKind, ProposalState } from '../db/placement-proposals'
import { ValidationError } from '../errors'
import { jsonBodyOrDefault } from './utils'
import { applyProposal } from '../services/placement-apply.service'
import { rollback } from '../services/placement-rollback.service'
import { checkDryRunFirst, noteDryRun } from '../services/apply-run-guards'
import { enqueueThoughtProposals, list as listProposals, reject } from '../services/placement-proposals.service'

const proposalsRouter = new Hono()

// Read-only: list queued placement proposals (default state=pending).
proposalsRouter.get('/', c => {
  return withTelemetry(c, { action: 'read', toolName: 'list_placement_proposals' }, c2 => {
    const state = c2.req.query('state') as ProposalState | undefined
    const itemKind = c2.req.query('item_kind') as ProposalItemKind | undefined
    const parsedLimit = c2.req.query('limit') ? Number(c2.req.query('limit')) : Number.NaN
    const limit = Number.isFinite(parsedLimit) ? Math.floor(parsedLimit) : undefined
    return c2.json(listProposals({ state, itemKind, projectId: c2.req.query('project_id'), limit }))
  })
})

// Write: propose a plan for a persisted thought and queue its confirmable items.
proposalsRouter.post('/', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'enqueue_placement_proposals' }, async c2 => {
    const body = await jsonBodyOrDefault<{ thought_id?: string; project_id?: string }>(c2, {})
    const rows = await enqueueThoughtProposals(body.thought_id as string, { projectId: body.project_id })
    return c2.json(rows, 201)
  })
})

// Write: roll back every reversible mutation of one explicit run (ADR §2.8).
proposalsRouter.post('/rollback', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'rollback_placement_proposals' }, async c2 => {
    const body = await jsonBodyOrDefault<{ run_id?: string; confirm?: boolean }>(c2, {})
    if (!body.run_id) throw new ValidationError('run_id is required')
    return c2.json(rollback(body.run_id, { confirm: body.confirm === true, decidedBy: 'api' }))
  })
})

// Write: apply exactly one queued proposal; dry-run unless confirm=true (ADR §2.10.3).
proposalsRouter.post('/:id/apply', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'apply_placement_proposal' }, async c2 => {
    const body = await jsonBodyOrDefault<{ confirm?: boolean; run_id?: string }>(c2, {})
    const proposalId = c2.req.param('id')!
    const confirm = body.confirm === true
    if (confirm) {
      const refusal = checkDryRunFirst([proposalId], body.run_id)
      if (refusal) return c2.json({ proposal_id: proposalId, status: 'refused', refusal })
    }
    const result = applyProposal(proposalId, { confirm, runId: body.run_id, decidedBy: 'api' })
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
