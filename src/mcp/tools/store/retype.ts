import { z } from 'zod/v4'
import { EDGE_TYPES, retypeEdge, validateRetypeService } from '../../../services/edges.service'
import { getDb } from '../../../db'
import { fingerprintOf, runGuarded } from '../../../services/confirm-gate.service'
import { guardedEnvelope } from '../envelope'
import { actionInput, requiredString, type ActionArgs, type ActionHandler } from '../action-tool'
import { STORE_ARGS } from './args'

export const retypeHandler: ActionHandler = {
  input: actionInput(STORE_ARGS, ['edge_id', 'new_type', 'confirm', 'preview_token'], {
    edge_id: requiredString('edge_id is required for retype action'),
    new_type: z.enum(EDGE_TYPES)
  }),
  async run(args: ActionArgs) {
    const edgeId = args.edge_id as string
    const newType = args.new_type as string

    const edge = validateRetypeService(edgeId, newType)
    const oldType = edge.type

    const outcome = await runGuarded(args, {
      kind: 'retype',
      targetId: edgeId,
      fingerprint: () =>
        fingerprintOf(edge.id, edge.source_id, edge.target_id, edge.type, edge.created_at, newType),
      preview: () => ({
        status: 'preview',
        edge_id: edgeId,
        old_edge_id: edgeId,
        old_type: oldType,
        new_type: newType,
        source_id: edge.source_id,
        target_id: edge.target_id,
        consequence: `Changes edge type from '${oldType}' to '${newType}'.`
      }),
      apply: () => {
        const retyped = retypeEdge(getDb(), edgeId, newType)
        return {
          status: 'retyped',
          edge_id: retyped.id,
          old_edge_id: edgeId,
          new_edge_id: retyped.id,
          old_type: oldType,
          new_type: newType
        }
      }
    })

    return guardedEnvelope('retype', outcome)
  }
}
