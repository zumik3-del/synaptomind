import { z } from 'zod/v4'
import { deleteEdgesBatchService } from '../../../services/edges.service'
import { BATCH_ITEMS_MAX } from '../../../validation'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

/**
 * `memory_store action=unlink_batch` (task #1972): several edges in one call.
 *
 * Mirrors `link_batch`/`archive_batch`: the batch runs in a single transaction
 * and reports per-edge status instead of failing whole. Unlike the single
 * `unlink` (which is idempotent per edge), the batch validates that every
 * `edge_id` exists before deleting any of them, so a missing id aborts the
 * whole batch instead of leaving a partial prune behind.
 *
 * `confirm` defaults to a non-mutating preview (`false`); pass `confirm: true`
 * to execute the deletes.
 */
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
    return deleteEdgesBatchService(args.edge_ids as string[], confirm)
  }
}