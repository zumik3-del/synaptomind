import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  enqueueThoughtProposals,
  list as listProposals,
  reject,
  type ListOptions
} from '../../services/placement-proposals.service'
import { applyBatch } from '../../services/placement-apply.service'
import { checkDryRunFirst, noteDryRun } from '../../services/apply-run-guards'
import { resolveProjectId } from './utils'
import { registerActionTool, requiredString, type ActionArgs } from './action-tool'
import { applyHandler, AGENT } from './review/apply'
import { rollbackHandler } from './review/rollback'

const ITEM_KINDS = ['edge', 'placement', 'lifecycle', 'triage_activate', 'triage_archive'] as const

const handlers = {
  enqueue: {
    input: z.object({ thought_id: requiredString('thought_id is required for enqueue action') }),
    run(args: ActionArgs) {
      const projectId = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
      return enqueueThoughtProposals(args.thought_id as string, { projectId })
    }
  },

  list: {
    run(args: ActionArgs) {
      const projectId = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
      return listProposals({
        state: args.state as ListOptions['state'],
        itemKind: args.item_kind as ListOptions['itemKind'],
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
      const confirm = args.confirm === true
      const runId = args.run_id as string | undefined
      const refusal = confirm ? checkDryRunFirst(proposalIds, runId) : undefined
      if (refusal) return { results: [], errors: [], refused: refusal }
      const outcome = applyBatch(proposalIds, {
        confirm,
        runId,
        limit: args.limit as number | undefined,
        decidedBy: AGENT
      })
      if (!confirm) noteDryRun(proposalIds, runId)
      return outcome
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
    description: `Review and apply the persisted placement-proposal queue. Actions:
- enqueue: Propose a read-only plan for a persisted thought and queue its confirmable items (drafts are not enqueued)
- list: List queued proposals (read-only; default state=pending)
- apply: Apply exactly one queued item (dry-run unless confirm=true); triage kinds require run_id
- apply_batch: Apply a list of queued items independently (dry-run unless confirm=true); enforces run_id, limit and the per-run triage caps
- rollback: Reverse a run's reversible mutations (dry-run report unless confirm=true)
- reject: Reject one pending item`,
    inputSchema: {
      action: z
        .enum(['enqueue', 'list', 'apply', 'apply_batch', 'rollback', 'reject'])
        .describe('Action'),
      thought_id: z.string().optional().describe('REQUIRED for "enqueue": persisted thought whose proposals are queued (create the thought first; drafts are not enqueued)'),
      proposal_id: z.string().optional().describe('REQUIRED for "apply"/"reject": queued proposal id'),
      proposal_ids: z.array(z.string()).optional().describe('REQUIRED for "apply_batch": queued proposal ids'),
      run_id: z.string().optional().describe('Run envelope: REQUIRED for "rollback" and for apply/apply_batch of triage_activate/triage_archive items. It groups the rows one rollback can reverse. An un-enveloped non-triage apply/apply_batch gets a synthesized "auto-" + UUIDv7 envelope, returned as run_id on the accepted result (apply) and on the batch outcome (apply_batch), so it is rollback-addressable. "rollback" refuses any row decided more than placement.proposalTtlDays (default 30) days before the server\'s own clock; no public surface accepts a caller-supplied clock. The cutoff is inclusive: a row decided exactly at the boundary is still reversible, and a negative proposalTtlDays disables the window entirely'),
      confirm: z.boolean().optional().describe('apply/apply_batch/rollback: set true to execute the write; absent/false is a non-mutating dry-run'),
      state: z.enum(['pending', 'accepted', 'rejected', 'expired', 'stale', 'rolled_back']).optional().describe('list: state filter (default pending)'),
      item_kind: z.enum(ITEM_KINDS).optional().describe('list: item-kind filter (edge | placement | lifecycle | triage_activate | triage_archive)'),
      project_id: z.string().optional().describe('Project ID (prefer cwd)'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project'),
      limit: z.number().int().min(1).max(1000).optional().describe('list: max rows (default 100); apply_batch: max items this call may apply')
    },
    handlers
  })
}
