import { z } from 'zod/v4'
import {
  retypeEdgeService,
  validateRetypeService,
  EDGE_TYPES
} from '../../../services/edges.service'
import { fingerprintOf, runGuarded } from '../../../services/confirm-gate.service'
import { itemEnvelope } from '../envelope'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

export const retypeHandler: ActionHandler = {
  input: z.object({
    edge_id: requiredString('edge_id is required for retype action'),
    new_type: z.enum(EDGE_TYPES),
    preview_token: z.string().optional()
  }),
  async run(args: ActionArgs) {
    const edgeId = args.edge_id as string
    const newType = args.new_type as string

    // Dry-run and confirm run the SAME validation (ADR §2): the preview
    // must never promise a confirm would reject.
    const edge = validateRetypeService(edgeId, newType)
    const oldType = edge.type

    const outcome = await runGuarded(args, {
      kind: 'retype',
      targetId: edgeId,
      fingerprint: () =>
        fingerprintOf(edge.id, edge.source_id, edge.target_id, edge.type, edge.created_at, newType),
      preview: token => ({
        status: 'preview',
        edge_id: edgeId,
        old_edge_id: edgeId,
        old_type: oldType,
        new_type: newType,
        source_id: edge.source_id,
        target_id: edge.target_id,
        consequence: `Changes edge type from '${oldType}' to '${newType}'.`,
        preview_token: token
      }),
      apply: () => {
        const retyped = retypeEdgeService(edgeId, newType)
        // retypeEdge does delete+insert, so the id changes — return the fresh
        // id so a chained unlink/retype resolves. Keep `edge_id` (new id) for
        // backward compatibility and expose both ids for traceability.
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

    return outcome.status === 'preview'
      ? itemEnvelope('retype', outcome.value, { preview: { token: outcome.token } })
      : itemEnvelope('retype', outcome.value)
  }
}
