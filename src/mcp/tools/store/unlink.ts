import { z } from 'zod/v4'
import { deleteEdgeService, findEdgeService } from '../../../services/edges.service'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

export const unlinkHandler: ActionHandler = {
  input: z.object({
    edge_id: requiredString('edge_id is required for unlink action')
  }),
  run(args: ActionArgs) {
    const edgeId = args.edge_id as string
    const confirm = args.confirm === true

    if (!confirm) {
      const edge = findEdgeService(edgeId)
      if (!edge) return { status: 'not_found', edge_id: edgeId }
      return {
        status: 'preview',
        edge_id: edgeId,
        edge: { id: edge.id, source_id: edge.source_id, target_id: edge.target_id, type: edge.type, created_at: edge.created_at },
        consequence: `Removes the '${edge.type}' edge between '${edge.source_id}' and '${edge.target_id}'.`,
        instruction: `Call memory_store again with action=unlink, edge_id=${edgeId}, confirm=true to proceed.`
      }
    }

    const deleted = deleteEdgeService(edgeId)
    return { status: deleted ? 'deleted' : 'not_found', edge_id: edgeId }
  }
}
