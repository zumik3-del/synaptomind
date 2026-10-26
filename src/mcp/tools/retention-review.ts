import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { listRetentionReviewCandidatesService, type RetentionReviewResult } from '../../services/retention-review.service'
import { getThoughtByIdService } from '../../services/thoughts.service'
import {
  compactRetentionReviewCandidatesService,
  deleteRetentionReviewCandidateService,
  protectRetentionReviewCandidateService
} from '../../services/retention-review-actions.service'
import { createPreviewTokenService, consumePreviewTokenService } from '../../services/preview-tokens.service'
import { collectionEnvelope, itemEnvelope } from './envelope'
import { registerActionTool, requiredString, type ActionArgs } from './action-tool'
import { shapeThought } from './utils'
import { BATCH_ITEMS_MAX } from '../../validation'

const handlers = {
  list: {
    run(args: ActionArgs) {
      const result = listRetentionReviewCandidatesService({
        minAgeDays: args.min_age_days as number | undefined,
        importanceFloor: args.importance_floor as number | undefined,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined
      })
      const compact = args.compact === true
      const fields = args.fields
      // Always shape: the default path applies the read-surface hygiene too
      // (tag names as strings, is_protected as a boolean) — task #2181.
      result.candidates = result.candidates.map((c) => shapeThought(c, compact, fields)) as RetentionReviewResult['candidates']
      // `total` is the candidate count for the filters, ignoring the page: the
      // page size and offset the caller supplied live in `meta.counts`.
      return collectionEnvelope('list', result.candidates, {
        total: result.total,
        counts: { limit: result.limit, offset: result.offset }
      })
    }
  },
  protect: {
    input: z.object({ thought_id: requiredString('thought_id is required for protect action') }),
    run(args: ActionArgs) {
      return itemEnvelope('protect', protectRetentionReviewCandidateService(args.thought_id as string))
    }
  },
  delete: {
    input: z.object({ thought_id: requiredString('thought_id is required for delete action'), preview_token: z.string().optional() }),
    run(args: ActionArgs) {
      const id = args.thought_id as string
      const confirm = args.confirm === true
      const previewToken = args.preview_token as string | undefined
      const thought = getThoughtByIdService(id)
      const fp = thought ? `${thought.id}:${thought.status}:${thought.created_at}:${thought.is_protected}` : `missing:${id}`

      if (!confirm) {
        const result = deleteRetentionReviewCandidateService(id, { confirm: false })
        const token = createPreviewTokenService('retention_delete', id, fp)
        return itemEnvelope(
          'delete',
          { ...(result as unknown as Record<string, unknown>), preview_token: token },
          { preview: { token, instruction: result.instruction } }
        )
      }

      if (thought) {
        if (!previewToken) throw new Error('preview_token is required')
        const verification = consumePreviewTokenService(previewToken, 'retention_delete', id, fp)
        if (!verification.valid) throw new Error(`preview token ${verification.reason ?? 'invalid'}`)
      }

      return itemEnvelope('delete', deleteRetentionReviewCandidateService(id, { confirm: true }))
    }
  },
  compact: {
    input: z.object({
      source_ids: z.array(z.string().min(1)).min(1, 'source_ids must be a non-empty array of thought IDs').max(BATCH_ITEMS_MAX, `source_ids accepts at most ${BATCH_ITEMS_MAX} ids per call`),
      summary: z.object({ content: z.string().min(1), tags: z.array(z.string()).optional(), project_id: z.string().min(1).optional() })
    }),
    run(args: ActionArgs) {
      const result = compactRetentionReviewCandidatesService({
        source_ids: args.source_ids as string[],
        summary: args.summary as { content: string; tags?: string[]; project_id?: string },
        confirm: args.confirm === true
      })
      const item = { ...result, ...(result.summary === undefined ? {} : { summary: shapeThought(result.summary) }) }
      // Compaction confirms on `confirm: true` alone (no token), so the gate
      // carries the instruction and a null token (task #2181).
      return result.preview
        ? itemEnvelope('compact', item, { counts: { sources: result.source_ids.length }, preview: { instruction: result.instruction } })
        : itemEnvelope('compact', item, { counts: { sources: result.source_ids.length } })
    }
  }
}

export function registerRetentionReview(server: McpServer): void {
  registerActionTool(server, {
    name: 'retention_review',
    description: 'Review retention candidates: list candidates, protect a thought, preview or confirm deletion, or compact candidates into a summary. Answers the shared envelope { items, meta } for list and { item, meta } for protect/delete/compact; a preview sets meta.preview={token,destructive:true}.',
    inputSchema: {
      action: z.enum(['list', 'protect', 'delete', 'compact']).describe('Action'),
       min_age_days: z.number().finite().positive().optional().describe('Minimum candidate age in days. Optional for list.'),
      importance_floor: z.number().finite().min(0).max(1).optional().describe('Maximum importance threshold. Optional for list.'),
       limit: z.number().int().min(1).max(100).optional().describe('Maximum candidates to return. Optional for list.'),
      offset: z.number().int().min(0).optional().describe('Candidate pagination offset. Optional for list.'),
      compact: z.boolean().optional().describe('Compact output: trim to minimal fields (id, content, status, tags as strings, project). OPTIONAL for "list". IGNORED for all other actions.'),
      fields: z.array(z.string()).optional().describe('Fields to include in output; intersected with available columns. OPTIONAL for "list". IGNORED for all other actions.'),
      thought_id: z.string().optional().describe('Thought ID. Required for protect and delete.'),
      preview_token: z.string().optional().describe('OPTIONAL preview token returned by a prior preview. CONSUMED by "delete" (true executes with token validation; missing/stale fails). IGNORED for all other actions.'),
       source_ids: z.array(z.string()).max(BATCH_ITEMS_MAX, `source_ids accepts at most ${BATCH_ITEMS_MAX} ids per call`).optional().describe('Source thought IDs. Required for compact.'),
      summary: z.object({ content: z.string(), tags: z.array(z.string()).optional(), project_id: z.string().optional() }).optional().describe('Summary thought input. Required for compact.'),
      confirm: z.boolean().optional().describe('When true, authorizes delete or compact; false or omitted previews. Ignored otherwise.')
    },
    handlers
  })
}
