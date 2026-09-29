import { Hono } from 'hono'
import { withTelemetry } from '../logging'
import type { ProposalState } from '../db/placement-proposals'
import { jsonBodyOrDefault } from './utils'
import { applyProposal } from '../services/placement-apply.service'
import { enqueueThoughtProposals, list as listProposals, reject } from '../services/placement-proposals.service'

const proposalsRouter = new Hono()

// Read-only: list queued placement proposals (default state=pending).
proposalsRouter.get('/', c => {
  return withTelemetry(c, { action: 'read', toolName: 'list_placement_proposals' }, c2 => {
    const state = c2.req.query('state') as ProposalState | undefined
    const parsedLimit = c2.req.query('limit') ? Number(c2.req.query('limit')) : Number.NaN
    const limit = Number.isFinite(parsedLimit) ? Math.floor(parsedLimit) : undefined
    return c2.json(listProposals({ state, projectId: c2.req.query('project_id'), limit }))
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

// Write: apply exactly one queued proposal; dry-run unless confirm=true (ADR §2.10.3).
proposalsRouter.post('/:id/apply', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'apply_placement_proposal' }, async c2 => {
    const body = await jsonBodyOrDefault<{ confirm?: boolean }>(c2, {})
    const result = applyProposal(c2.req.param('id')!, { confirm: body.confirm === true, decidedBy: 'api' })
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
