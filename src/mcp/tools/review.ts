import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { proposalsLimitSchema } from '../../validation'
import {
  enqueueThoughtProposals,
  listPlacementProposalsService as listProposals,
  rejectPlacementProposalService as reject,
  type ListOptions
} from '../../services/placement-proposals.service'
import { applyBatchService } from '../../services/placement-apply.service'
import { resolveProjectId } from './utils'
import { registerActionTool, requiredString, type ActionArgs } from './action-tool'
import { applyHandler, AGENT } from './review/apply'
import { rollbackHandler } from './review/rollback'

const ITEM_KINDS = ['edge'] as const

const handlers = {
  enqueue: {
    input: z.object({ thought_id: requiredString('thought_id is required for enqueue action') }),
    run(args: ActionArgs) {
      const projectId = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
      return enqueueThoughtProposals(args.thought_id as string, {
        projectId,
        maxProposals: args.max_proposals as number | undefined,
        max_proposals: args.max_proposals as number | undefined,
        maxItems: args.max_items as number | undefined,
        max_items: args.max_items as number | undefined,
        maxItemsPerEnqueue: args.max_items as number | undefined,
        limit: args.limit as number | undefined
      })
    }
  },

  list: {
    run(args: ActionArgs) {
      const projectId = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
      return listProposals({
        state: args.state as ListOptions['state'],
        itemKind: args.item_kind as ListOptions['itemKind'],
        sourceThoughtId: args.source_thought_id as string | undefined,
        createdAfter: args.created_after as string | undefined,
        projectId,
        limit: args.limit as number | undefined
      })
    }
  },

  apply: applyHandler,

  apply_batch: {
    input: z.object({ proposal_ids: z.array(z.string()).min(1, 'proposal_ids must be a non-empty array') }),
    run(args: ActionArgs) {
      const proposalIds = args.proposal_ids as string[]
      return applyBatchService(proposalIds, {
        confirm: args.confirm === true,
        runId: args.run_id as string | undefined,
        limit: args.limit as number | undefined,
        decidedBy: AGENT
      })
    }
  },

  rollback: rollbackHandler,

  reject: {
    input: z.object({ proposal_id: requiredString('proposal_id is required for reject action') }),
    run(args: ActionArgs) {
      return reject(args.proposal_id as string, { decidedBy: AGENT })
    }
  }
}

export function registerMemoryReview(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_review',
    description: `Review and apply placement proposals. Actions: enqueue (persisted thought only; queues the plan's edge items and reports the skipped ones), list (default pending), apply (dry-run unless confirm=true), apply_batch (per-call cap), rollback (dry-run), reject. Rows of a retired item kind (triage_*) stay listable but cannot be applied.`,
    inputSchema: {
      action: z
        .enum(['enqueue', 'list', 'apply', 'apply_batch', 'rollback', 'reject'])
        .describe('Action'),
      thought_id: z.string().optional().describe('REQUIRED for "enqueue": persisted thought whose proposals are queued (create the thought first; drafts are not enqueued)'),
      max_proposals: z.number().int().min(1).optional().describe('enqueue: cap on the number of proposals generated for this thought (default placement.maxProposalsPerEnqueue)'),
      max_items: z.number().int().min(1).optional().describe('enqueue: alias for max_proposals'),
      proposal_id: z.string().optional().describe('REQUIRED for "apply"/"reject": queued proposal id'),
      proposal_ids: z.array(z.string()).optional().describe('REQUIRED for "apply_batch": queued proposal ids'),
      run_id: z.string().optional().describe('Run envelope: REQUIRED for "rollback". It groups the rows one rollback can reverse. An un-enveloped apply/apply_batch gets a synthesized "auto-" + UUIDv7 envelope, returned as run_id on the accepted result (apply) and on the batch outcome (apply_batch), so it is rollback-addressable. "rollback" refuses any row decided more than placement.proposalTtlDays (default 30) days before the server\'s own clock; no public surface accepts a caller-supplied clock. The cutoff is inclusive: a row decided exactly at the boundary is still reversible, and a negative proposalTtlDays disables the window entirely'),
      confirm: z.boolean().optional().describe('apply/apply_batch/rollback: set true to execute the write; absent/false is a non-mutating dry-run'),
      state: z.enum(['pending', 'accepted', 'rejected', 'expired', 'stale', 'rolled_back']).optional().describe('list: state filter (default pending)'),
      item_kind: z.enum(ITEM_KINDS).optional().describe('list: item-kind filter (edge)'),
      source_thought_id: z.string().optional().describe('list: filter queued proposals by source thought id'),
      created_after: z.string().optional().describe('list: only proposals created at or after this ISO timestamp'),
      project_id: z.string().optional().describe('Project ID (prefer cwd)'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project'),
      limit: proposalsLimitSchema.optional().describe('list: max rows (default 100, 1-1000); apply_batch: max items this call may apply')
    },
    handlers
  })
}
