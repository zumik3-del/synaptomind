import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { listRetentionReviewCandidatesService } from '../../services/retention-review.service'
import {
  compactRetentionReviewCandidatesService,
  deleteRetentionReviewCandidateService,
  protectRetentionReviewCandidateService
} from '../../services/retention-review-actions.service'
import { registerActionTool, requiredString, type ActionArgs } from './action-tool'

const handlers = {
  list: {
    run(args: ActionArgs) {
      return listRetentionReviewCandidatesService({
        minAgeDays: args.min_age_days as number | undefined,
        importanceFloor: args.importance_floor as number | undefined,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined
      })
    }
  },
  protect: {
    input: z.object({ thought_id: requiredString('thought_id is required for protect action') }),
    run(args: ActionArgs) { return protectRetentionReviewCandidateService(args.thought_id as string) }
  },
  delete: {
    input: z.object({ thought_id: requiredString('thought_id is required for delete action') }),
    run(args: ActionArgs) { return deleteRetentionReviewCandidateService(args.thought_id as string, { confirm: args.confirm === true }) }
  },
  compact: {
    input: z.object({
      source_ids: z.array(z.string().min(1)).min(1, 'source_ids must be a non-empty array of thought IDs'),
      summary: z.object({ content: z.string().min(1), tags: z.array(z.string()).optional(), project_id: z.string().min(1).optional() })
    }),
    run(args: ActionArgs) {
      return compactRetentionReviewCandidatesService({
        source_ids: args.source_ids as string[],
        summary: args.summary as { content: string; tags?: string[]; project_id?: string },
        confirm: args.confirm === true
      })
    }
  }
}

export function registerRetentionReview(server: McpServer): void {
  registerActionTool(server, {
    name: 'retention_review',
    description: 'Review retention candidates: list candidates, protect a thought, preview or confirm deletion, or compact candidates into a summary.',
    inputSchema: {
      action: z.enum(['list', 'protect', 'delete', 'compact']).describe('Action'),
       min_age_days: z.number().finite().positive().optional().describe('Minimum candidate age in days. Optional for list.'),
      importance_floor: z.number().finite().min(0).max(1).optional().describe('Maximum importance threshold. Optional for list.'),
       limit: z.number().int().min(1).max(100).optional().describe('Maximum candidates to return. Optional for list.'),
      offset: z.number().int().min(0).optional().describe('Candidate pagination offset. Optional for list.'),
      thought_id: z.string().optional().describe('Thought ID. Required for protect and delete.'),
      source_ids: z.array(z.string()).optional().describe('Source thought IDs. Required for compact.'),
      summary: z.object({ content: z.string(), tags: z.array(z.string()).optional(), project_id: z.string().optional() }).optional().describe('Summary thought input. Required for compact.'),
      confirm: z.boolean().optional().describe('When true, authorizes delete or compact; false or omitted previews. Ignored otherwise.')
    },
    handlers
  })
}
