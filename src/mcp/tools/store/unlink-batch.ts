import { deleteEdgesBatchService } from '../../../services/edges.service'
import { collectionEnvelope } from '../envelope'
import { actionInput, type ActionArgs, type ActionHandler } from '../action-tool'
import { STORE_ARGS } from './args'
import { edgeIdsArg } from './items'

export const unlinkBatchHandler: ActionHandler = {
  input: actionInput(STORE_ARGS, ['edge_ids', 'confirm'], { edge_ids: edgeIdsArg }),
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
