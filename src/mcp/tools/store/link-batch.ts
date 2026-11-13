import { z } from 'zod/v4'
import {
  createEdgesBatchService,
  EDGE_TYPES,
  type LinkBatchItem
} from '../../../services/edges.service'
import { BATCH_ITEMS_MAX } from '../../../validation'
import { collectionEnvelope } from '../envelope'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

const linkItem = z.object({
  source: requiredString('each link requires a non-empty source thought id'),
  target: requiredString('each link requires a non-empty target thought id'),
  type: z.enum(EDGE_TYPES).optional()
})

interface LinkBatchRow {
  index: number
  status: 'linked' | 'failed'
  source: string
  target: string
  type?: string
  error?: string
}

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
    const failures = new Map(result.errors.map(error => [error.index, error.error]))
    const rows: LinkBatchRow[] = links.map((link, index) => {
      const error = failures.get(index)
      const row: LinkBatchRow = {
        index,
        status: error === undefined ? 'linked' : 'failed',
        source: link.source,
        target: link.target
      }
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
