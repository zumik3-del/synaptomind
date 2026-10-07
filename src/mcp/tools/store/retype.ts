import { z } from 'zod/v4'
import { retypeEdgeService, validateRetypeService, EDGE_TYPES } from '../../../services/edges.service'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

export const retypeHandler: ActionHandler = {
  input: z.object({
    edge_id: requiredString('edge_id is required for retype action'),
    new_type: z.enum(EDGE_TYPES)
  }),
  run(args: ActionArgs) {
    const edgeId = args.edge_id as string
    const newType = args.new_type as string
    const confirm = args.confirm === true

    // Dry-run and confirm run the SAME validation (ADR §2): the preview
    // must never promise a confirm would reject.
    const edge = validateRetypeService(edgeId, newType)

    if (!confirm) {
      return {
        status: 'preview',
        edge_id: edgeId,
        old_type: edge.type,
        new_type: newType,
        source_id: edge.source_id,
        target_id: edge.target_id,
        consequence: `Changes edge type from '${edge.type}' to '${newType}'.`
      }
    }

    const oldType = edge.type
    const retyped = retypeEdgeService(edgeId, newType)
    // retypeEdge does delete+insert, so the id changes — return the fresh
    // id so a chained unlink/retype resolves.
    return { status: 'retyped', edge_id: retyped.id, old_type: oldType, new_type: newType }
  }
}
