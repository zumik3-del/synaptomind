import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  enqueueThoughtProposals,
  list as listProposals,
  reject,
  type ListOptions
} from '../../services/placement-proposals.service'
import { applyBatch, applyProposal } from '../../services/placement-apply.service'
import { resolveProjectId } from './utils'
import { registerActionTool, requiredString, type ActionArgs } from './action-tool'

/** Audit label recorded on apply/reject decisions (ADR §2.8). */
const AGENT = 'memory_review'

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
        projectId,
        limit: args.limit as number | undefined
      })
    }
  },

  apply: {
    input: z.object({ proposal_id: requiredString('proposal_id is required for apply action') }),
    run(args: ActionArgs) {
      return applyProposal(args.proposal_id as string, {
        confirm: args.confirm === true,
        decidedBy: AGENT
      })
    }
  },

  apply_batch: {
    input: z.object({ proposal_ids: z.array(z.string()).min(1, 'proposal_ids must be a non-empty array') }),
    run(args: ActionArgs) {
      return applyBatch(args.proposal_ids as string[], {
        confirm: args.confirm === true,
        decidedBy: AGENT
      })
    }
  },

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
- apply: Apply exactly one queued item (dry-run unless confirm=true)
- apply_batch: Apply a list of queued items independently (dry-run unless confirm=true)
- reject: Reject one pending item`,
    inputSchema: {
      action: z.enum(['enqueue', 'list', 'apply', 'apply_batch', 'reject']).describe('Action'),
      thought_id: z.string().optional().describe('REQUIRED for "enqueue": persisted thought whose proposals are queued (create the thought first; drafts are not enqueued)'),
      proposal_id: z.string().optional().describe('REQUIRED for "apply"/"reject": queued proposal id'),
      proposal_ids: z.array(z.string()).optional().describe('REQUIRED for "apply_batch": queued proposal ids'),
      confirm: z.boolean().optional().describe('apply/apply_batch: set true to execute the write; absent/false is a non-mutating dry-run'),
      state: z.enum(['pending', 'accepted', 'rejected', 'expired', 'stale']).optional().describe('list: state filter (default pending)'),
      project_id: z.string().optional().describe('Project ID (prefer cwd)'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project'),
      limit: z.number().int().min(1).max(1000).optional().describe('list: max rows (default 100)')
    },
    handlers
  })
}
