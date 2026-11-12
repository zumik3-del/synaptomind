import { z } from 'zod/v4'
import { deleteEdgeService, findEdgeService } from '../../../services/edges.service'
import { fingerprintOf, runGuarded } from '../../../services/confirm-gate.service'
import { itemEnvelope } from '../envelope'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

export const unlinkHandler: ActionHandler = {
  input: z.object({
    edge_id: requiredString('edge_id is required for unlink action'),
    preview_token: z.string().optional()
  }),
  async run(args: ActionArgs) {
    const edgeId = args.edge_id as string
    const edge = findEdgeService(edgeId)
    if (!edge) return itemEnvelope('unlink', { status: 'not_found', edge_id: edgeId })

    const outcome = await runGuarded(args, {
      kind: 'unlink',
      targetId: edgeId,
      fingerprint: () =>
        fingerprintOf(edge.id, edge.source_id, edge.target_id, edge.type, edge.created_at),
      preview: token => {
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
          preview_token: token,
          instruction
        }
      },
      apply: () => ({
        status: deleteEdgeService(edgeId) ? 'deleted' : 'not_found',
        edge_id: edgeId
      })
    })

    return outcome.status === 'preview'
      ? itemEnvelope('unlink', outcome.value, { preview: { token: outcome.token } })
      : itemEnvelope('unlink', outcome.value)
  }
}
