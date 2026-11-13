import { z } from 'zod/v4'
import {
  BULK_ITEMS_MAX,
  type BulkCreateItem,
  bulkCreateThoughtsService
} from '../../../services/bulk.service'
import { collectionEnvelope, writeEnvelopeScope } from '../envelope'
import { resolveProjectId, shapeThought } from '../utils'
import type { ActionArgs, ActionHandler } from '../action-tool'
import { createItemShape, isProfileRefusal } from './create'

export const bulkCreateItemSchema = z.strictObject({
  ...createItemShape('each thought requires a non-empty content'),
  project_id: z
    .string()
    .optional()
    .describe(
      'OPTIONAL per item: pin this item to its own project id. Unlike the top-level project_id (removed — use cwd), a bulk item may override the project the call resolves from cwd; omit it to take the cwd-resolved project.'
    ),
  source: z
    .string()
    .optional()
    .describe('OPTIONAL per item: the source label of this thought (the API default is "mcp").'),
  relation: z
    .string()
    .optional()
    .describe(
      'OPTIONAL per item: edge type of the parent link when parent_id is set (default "parent"). IGNORED when parent_id is omitted.'
    ),
  is_profile: isProfileRefusal
})

interface BulkCreateRow {
  index: number
  status: 'created' | 'failed'
  thought?: unknown
  error?: string
}

export const bulkCreateHandler: ActionHandler = {
  input: z.object({
    thoughts: z
      .array(bulkCreateItemSchema, { error: 'thoughts is required for bulk_create action' })
      .min(1, 'thoughts is required for bulk_create action')
      .max(BULK_ITEMS_MAX, `thoughts accepts at most ${BULK_ITEMS_MAX} items per call`)
  }),
  run(args: ActionArgs) {
    const items = args.thoughts as BulkCreateItem[] | undefined
    const defaultProjectId = resolveProjectId(args.cwd as string | undefined)
    const { created, errors } = bulkCreateThoughtsService(items, defaultProjectId)
    const rows: BulkCreateRow[] = [
      ...created.map(item => ({
        index: item.index,
        status: 'created' as const,
        thought: shapeThought(item.thought)
      })),
      ...errors.map(error => ({
        index: error.index,
        status: 'failed' as const,
        error: error.error
      }))
    ].sort((a, b) => a.index - b.index)
    return collectionEnvelope('bulk_create', rows, {
      ...writeEnvelopeScope(args.cwd),
      total: rows.length,
      counts: { created: created.length, failed: errors.length }
    })
  }
}
