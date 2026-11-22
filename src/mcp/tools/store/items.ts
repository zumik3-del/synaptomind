import { z } from 'zod/v4'
import { EDGE_TYPES } from '../../../services/edges.service'
import { BULK_ITEMS_MAX } from '../../../services/bulk.service'
import { BATCH_ITEMS_MAX, thoughtStatusSchema } from '../../../validation'
import { requiredString } from '../action-tool'

export const urlLinkItem = z.object({ text: z.string(), url: z.string() })

export const isProfileRefusal = z
  .never({ error: 'is_profile is retired; remove this field. There is no replacement.' })
  .optional()

export function createItemShape(contentMessage: string) {
  return {
    content: requiredString(contentMessage),
    tags: z.array(z.string()).optional(),
    status: thoughtStatusSchema.optional(),
    parent_id: z.string().optional(),
    is_protected: z.boolean().optional(),
    is_global: z.boolean().optional(),
    url_links: z.array(urlLinkItem).optional()
  }
}

export const bulkCreateItemSchema = z.strictObject({
  ...createItemShape('each thought requires a non-empty content'),
  project_id: z
    .string()
    .optional()
    .describe(
      'OPTIONAL per item: pin this item to its own project id. Unlike the top-level project_id (removed — use cwd), a bulk item may override the project the call resolves from cwd; omit it to take the cwd-resolved project, or the default project when the cwd matches none.'
    ),
  source: z
    .string()
    .optional()
    .describe(
      'OPTIONAL per item: the source label, stored exactly as given and never defaulted — an omitted source is written as NULL, not "mcp". That is the difference from action=create, which always stamps source "mcp": the graph maps source "mcp" to the agent category, so a bulk item with no source is categorised by its tags instead.'
    ),
  relation: z
    .string()
    .optional()
    .describe(
      'OPTIONAL per item: edge type of the parent link when parent_id is set (default "parent"). IGNORED when parent_id is omitted.'
    ),
  is_profile: isProfileRefusal
})

export const thoughtsArg = z
  .array(bulkCreateItemSchema)
  .min(1, 'thoughts is required for bulk_create action')
  .max(BULK_ITEMS_MAX, `thoughts accepts at most ${BULK_ITEMS_MAX} items per call`)

const linkItem = z.object({
  source: requiredString('each link requires a non-empty source thought id'),
  target: requiredString('each link requires a non-empty target thought id'),
  type: z.enum(EDGE_TYPES).optional()
})

export const linksArg = z
  .array(linkItem, { error: 'links is required for link_batch action' })
  .min(1, 'links is required for link_batch action')
  .max(BATCH_ITEMS_MAX, `links accepts at most ${BATCH_ITEMS_MAX} items per call`)

export const edgeIdsArg = z
  .array(requiredString('each edge_ids entry must be a non-empty id'), {
    error: 'edge_ids is required for unlink_batch action'
  })
  .min(1, 'edge_ids is required for unlink_batch action')
  .max(BATCH_ITEMS_MAX, `edge_ids accepts at most ${BATCH_ITEMS_MAX} ids per call`)
