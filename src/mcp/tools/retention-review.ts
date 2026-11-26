import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import {
  listRetentionReviewCandidatesService,
  type RetentionReviewResult
} from '../../services/retention-review.service'
import { getThoughtByIdService } from '../../services/thoughts.service'
import {
  compactRetentionReviewCandidatesService,
  deleteRetentionReviewCandidateService
} from '../../services/retention-review-actions.service'
import { fingerprintOf, runGuarded } from '../../services/confirm-gate.service'
import { collectionEnvelope, itemEnvelope } from './envelope'
import {
  DESTRUCTIVE,
  actionInput,
  registerActionTool,
  requiredString,
  type ActionArgs
} from './action-tool'
import { shapeEntity } from './utils'
import { BATCH_ITEMS_MAX } from '../../validation'

const RETENTION_ARGS = {
  min_age_days: z.coerce
    .number()
    .finite()
    .positive()
    .optional()
    .describe(
      'Minimum candidate age in days. OPTIONAL for "list". REJECTED for all other actions.'
    ),
  importance_floor: z.coerce
    .number()
    .finite()
    .min(0)
    .max(1)
    .optional()
    .describe('Maximum importance threshold. OPTIONAL for "list". REJECTED for all other actions.'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Maximum candidates to return. OPTIONAL for "list". REJECTED for all other actions.'),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Candidate pagination offset. OPTIONAL for "list". REJECTED for all other actions.'),
  compact: z
    .boolean()
    .optional()
    .describe(
      'Compact output (default true): trim each candidate to the minimal thought fields (id, content, status, tags as strings, project). compact=false returns the whole row. OPTIONAL for "list". REJECTED for all other actions.'
    ),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      'Thought columns to include in each candidate; explicit fields win over compact. OPTIONAL for "list". REJECTED for all other actions.'
    ),
  thought_id: z
    .string()
    .optional()
    .describe('Thought ID. REQUIRED for "delete". REJECTED for "list" and "compact".'),
  preview_token: z
    .string()
    .optional()
    .describe(
      'OPTIONAL preview token returned by a prior preview. CONSUMED by "delete" (true executes with token validation; missing/stale fails). REJECTED for "list" and "compact".'
    ),
  source_ids: z
    .array(z.string())
    .max(BATCH_ITEMS_MAX, `source_ids accepts at most ${BATCH_ITEMS_MAX} ids per call`)
    .optional()
    .describe(
      'REQUIRED for "compact": source thought IDs to compress into one summary. REJECTED for all other actions.'
    ),
  summary: z
    .object({
      content: z.string(),
      tags: z.array(z.string()).optional(),
      project_id: z.string().optional()
    })
    .optional()
    .describe('REQUIRED for "compact": the summary thought input. REJECTED for all other actions.'),
  confirm: z
    .boolean()
    .optional()
    .describe(
      'CONSUMED by "delete" and "compact" (true executes; false/omitted previews). REJECTED for "list".'
    )
}

const handlers = {
  list: {
    input: actionInput(RETENTION_ARGS, [
      'min_age_days',
      'importance_floor',
      'limit',
      'offset',
      'compact',
      'fields'
    ]),
    run(args: ActionArgs) {
      const result = listRetentionReviewCandidatesService({
        minAgeDays: args.min_age_days as number | undefined,
        importanceFloor: args.importance_floor as number | undefined,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined
      })
      const compact = args.compact !== false
      const fields = args.fields
      const candidates = result.candidates.map(c => shapeEntity(c, { compact, fields }))
      result.candidates = candidates as RetentionReviewResult['candidates']
      return collectionEnvelope('list', result.candidates, {
        total: result.total,
        counts: { limit: result.limit, offset: result.offset }
      })
    }
  },
  delete: {
    input: actionInput(RETENTION_ARGS, ['thought_id', 'confirm', 'preview_token'], {
      thought_id: requiredString('thought_id is required for delete action')
    }),
    async run(args: ActionArgs) {
      const id = args.thought_id as string
      const thought = getThoughtByIdService(id)
      const outcome = await runGuarded(args, {
        kind: 'retention_delete',
        targetId: id,
        fingerprint: () =>
          thought
            ? fingerprintOf(thought.id, thought.status, thought.created_at, thought.is_protected)
            : null,
        preview: token => {
          const result = deleteRetentionReviewCandidateService(id, { confirm: false })
          return itemEnvelope('delete', result, {
            preview: { token, instruction: result.instruction }
          })
        },
        apply: () =>
          itemEnvelope('delete', deleteRetentionReviewCandidateService(id, { confirm: true }))
      })
      return outcome.value
    }
  },
  compact: {
    input: actionInput(RETENTION_ARGS, ['source_ids', 'summary', 'confirm'], {
      source_ids: z
        .array(z.string().min(1))
        .min(1, 'source_ids must be a non-empty array of thought IDs')
        .max(BATCH_ITEMS_MAX, `source_ids accepts at most ${BATCH_ITEMS_MAX} ids per call`),
      summary: z.object({
        content: z.string().min(1),
        tags: z.array(z.string()).optional(),
        project_id: z.string().min(1).optional()
      })
    }),
    run(args: ActionArgs) {
      const result = compactRetentionReviewCandidatesService({
        source_ids: args.source_ids as string[],
        summary: args.summary as { content: string; tags?: string[]; project_id?: string },
        confirm: args.confirm === true
      })
      const item = {
        ...result,
        ...(result.summary === undefined ? {} : { summary: shapeEntity(result.summary) })
      }
      return result.preview
        ? itemEnvelope('compact', item, {
            counts: { sources: result.source_ids.length },
            preview: { instruction: result.instruction }
          })
        : itemEnvelope('compact', item, { counts: { sources: result.source_ids.length } })
    }
  }
}

export function registerRetentionReview(server: McpServer): void {
  registerActionTool(server, {
    name: 'retention_review',
    annotations: DESTRUCTIVE,
    description:
      'Review retention candidates: list candidates, preview or confirm deletion, or compact candidates into a summary. To keep a thought instead of deleting it, call memory_store action=update with is_protected=true (which also drops it out of the candidate list). Answers the shared envelope { items, meta } for list and { item, meta } for delete/compact; a preview sets meta.preview={token,destructive:true}. Actions accept only their own arguments.',
    inputSchema: {
      action: z.enum(['list', 'delete', 'compact']).describe('Action'),
      ...RETENTION_ARGS
    },
    handlers,
    retiredActions: {
      protect: 'protect was removed; use memory_store action=update with is_protected=true'
    }
  })
}
