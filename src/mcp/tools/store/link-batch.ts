import { z } from 'zod/v4'
import { createEdgesBatchService, EDGE_TYPES, type LinkBatchItem } from '../../../services/edges.service'
import { BATCH_ITEMS_MAX } from '../../../validation'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

const linkItem = z.object({
  source: requiredString('each link requires a non-empty source thought id'),
  target: requiredString('each link requires a non-empty target thought id'),
  type: z.enum(EDGE_TYPES).optional()
})

/**
 * `memory_store action=link_batch` (task #1964): several edges in one call.
 *
 * The item shape is `{source, target, type?}` rather than the single action's
 * `thought_id`/`target_id`/`edge_type` so a batch reads as a list of pairs; the
 * writer underneath is the same `createEdgeService`, and the batch reports
 * per-item failures instead of failing whole.
 */
export const linkBatchHandler: ActionHandler = {
  input: z.object({
    links: z
      .array(linkItem, { error: 'links is required for link_batch action' })
      .min(1, 'links is required for link_batch action')
      .max(BATCH_ITEMS_MAX, `links accepts at most ${BATCH_ITEMS_MAX} items per call`)
  }),
  run(args: ActionArgs) {
    return createEdgesBatchService(args.links as LinkBatchItem[])
  }
}
