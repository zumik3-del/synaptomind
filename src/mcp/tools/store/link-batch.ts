import { z } from 'zod/v4'
import { createEdgesBatchService, EDGE_TYPES, type LinkBatchItem } from '../../../services/edges.service'
import { BATCH_ITEMS_MAX } from '../../../validation'
import { collectionEnvelope } from '../envelope'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

const linkItem = z.object({
  source: requiredString('each link requires a non-empty source thought id'),
  target: requiredString('each link requires a non-empty target thought id'),
  type: z.enum(EDGE_TYPES).optional()
})

/** One requested link as the wire reports it: the input pair plus its outcome. */
interface LinkBatchRow {
  index: number
  status: 'linked' | 'failed'
  source: string
  target: string
  type?: string
  error?: string
}

/**
 * `memory_store action=link_batch` (task #1964): several edges in one call.
 *
 * The item shape is `{source, target, type?}` rather than the single action's
 * `thought_id`/`target_id`/`edge_type` so a batch reads as a list of pairs; the
 * writer underneath is the same `createEdgeService`, and the batch reports
 * per-item failures instead of failing whole. The answer carries one row per
 * requested link (task #2181) and the aggregate in `meta.counts`.
 */
export const linkBatchHandler: ActionHandler = {
  input: z.object({
    links: z
      .array(linkItem, { error: 'links is required for link_batch action' })
      .min(1, 'links is required for link_batch action')
      .max(BATCH_ITEMS_MAX, `links accepts at most ${BATCH_ITEMS_MAX} items per call`)
  }),
  run(args: ActionArgs) {
    const links = args.links as LinkBatchItem[]
    const result = createEdgesBatchService(links)
    // The batch service reports failures by index; the row list is the input
    // order with the outcome filled in, so a caller can map rows to its request.
    const failures = new Map(result.errors.map(error => [error.index, error.error]))
    const rows: LinkBatchRow[] = links.map((link, index) => {
      const error = failures.get(index)
      const row: LinkBatchRow = { index, status: error === undefined ? 'linked' : 'failed', source: link.source, target: link.target }
      if (link.type !== undefined) row.type = link.type
      if (error !== undefined) row.error = error
      return row
    })
    return collectionEnvelope('link_batch', rows, {
      total: links.length,
      counts: { linked: result.linked, failed: result.failed }
    })
  }
}
