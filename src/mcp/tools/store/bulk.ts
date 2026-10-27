import type { BulkCreateItem } from '../../../services/bulk.service'
import { bulkCreateThoughtsService } from '../../../services/bulk.service'
import { collectionEnvelope, writeEnvelopeScope } from '../envelope'
import { resolveProjectId, shapeThought } from '../utils'
import type { ActionArgs, ActionHandler } from '../action-tool'

/** One requested thought as the wire reports it: its outcome plus the row when created. */
interface BulkCreateRow {
  index: number
  status: 'created' | 'failed'
  thought?: unknown
  error?: string
}

export const bulkCreateHandler: ActionHandler = {
  run(args: ActionArgs) {
    const items = args.thoughts as BulkCreateItem[] | undefined
    const defaultProjectId = resolveProjectId(args.cwd as string | undefined)
    const { created, errors } = bulkCreateThoughtsService(items, defaultProjectId)
    // One row per requested item, in input order, so a partial failure stays
    // readable: the aggregate lives in `meta.counts` (task #2181).
    const rows: BulkCreateRow[] = [
      ...created.map(item => ({ index: item.index, status: 'created' as const, thought: shapeThought(item.thought) })),
      ...errors.map(error => ({ index: error.index, status: 'failed' as const, error: error.error }))
    ].sort((a, b) => a.index - b.index)
    return collectionEnvelope('bulk_create', rows, {
      ...writeEnvelopeScope(args.cwd),
      total: rows.length,
      counts: { created: created.length, failed: errors.length }
    })
  }
}
