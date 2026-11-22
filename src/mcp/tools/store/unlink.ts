import { deleteEdgeService } from '../../../services/edges.service'
import { getDb } from '../../../db'
import { findEdge } from '../../../db/edges'
import { fingerprintOf, runGuarded } from '../../../services/confirm-gate.service'
import { guardedEnvelope, itemEnvelope } from '../envelope'
import { actionInput, requiredString, type ActionArgs, type ActionHandler } from '../action-tool'
import { STORE_ARGS } from './args'

export const unlinkHandler: ActionHandler = {
  input: actionInput(STORE_ARGS, ['edge_id', 'confirm', 'preview_token'], {
    edge_id: requiredString('edge_id is required for unlink action')
  }),
  async run(args: ActionArgs) {
    const edgeId = args.edge_id as string
    const edge = findEdge(getDb(), edgeId)
    if (!edge) return itemEnvelope('unlink', { status: 'not_found', edge_id: edgeId })

    const outcome = await runGuarded(args, {
      kind: 'unlink',
      targetId: edgeId,
      fingerprint: () =>
        fingerprintOf(edge.id, edge.source_id, edge.target_id, edge.type, edge.created_at),
      preview: () => {
        const consequence = `Removes the '${edge.type}' edge between '${edge.source_id}' and '${edge.target_id}'.`
        const instruction = `Call memory_store again with action=unlink, edge_id=${edgeId}, confirm=true to proceed.`
        return {
          status: 'preview',
          edge_id: edgeId,
          edge: {
            id: edge.id,
            source_id: edge.source_id,
            target_id: edge.target_id,
            type: edge.type,
            created_at: edge.created_at
          },
          consequence,
          instruction
        }
      },
      apply: () => ({
        status: deleteEdgeService(edgeId) ? 'deleted' : 'not_found',
        edge_id: edgeId
      })
    })

    return guardedEnvelope('unlink', outcome)
  }
}
