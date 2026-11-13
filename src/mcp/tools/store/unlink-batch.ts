import { z } from 'zod/v4'
import { deleteEdgesBatchService } from '../../../services/edges.service'
import { BATCH_ITEMS_MAX } from '../../../validation'
import { collectionEnvelope } from '../envelope'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

export const unlinkBatchHandler: ActionHandler = {
  input: z.object({
    edge_ids: z
      .array(requiredString('each edge_ids entry must be a non-empty id'), {
        error: 'edge_ids is required for unlink_batch action'
      })
      .min(1, 'edge_ids is required for unlink_batch action')
      .max(BATCH_ITEMS_MAX, `edge_ids accepts at most ${BATCH_ITEMS_MAX} ids per call`)
  }),
  run(args: ActionArgs) {
    const confirm = args.confirm === true
    const result = deleteEdgesBatchService(args.edge_ids as string[], confirm)
    return collectionEnvelope('unlink_batch', result.results, {
      total: result.total,
      counts: { deleted: result.deleted, preview: result.preview, failed: result.failed },
      ...(confirm ? {} : { preview: { instruction: result.instruction } })
    })
  }
}
