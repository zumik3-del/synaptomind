import { bulkCreateThoughtsService, type BulkCreateItem } from '../../../services/bulk.service'
import { collectionEnvelope, writeEnvelopeScope } from '../envelope'
import { resolveProjectId, shapeEntity } from '../utils'
import { actionInput, type ActionArgs, type ActionHandler } from '../action-tool'
import { STORE_ARGS } from './args'
import { thoughtsArg } from './items'

interface BulkCreateRow {
  index: number
  status: 'created' | 'failed'
  thought?: unknown
  error?: string
}

export const bulkCreateHandler: ActionHandler = {
  input: actionInput(STORE_ARGS, ['thoughts'], { thoughts: thoughtsArg }),
  run(args: ActionArgs) {
    const items = args.thoughts as BulkCreateItem[]
    const defaultProjectId = resolveProjectId(args.cwd as string | undefined)
    const { created, errors } = bulkCreateThoughtsService(items, defaultProjectId)
    const rows: BulkCreateRow[] = [
      ...created.map(item => ({
        index: item.index,
        status: 'created' as const,
        thought: shapeEntity(item.thought)
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
