import { z } from 'zod/v4'
import { retypeEdgeService, validateRetypeService, EDGE_TYPES } from '../../../services/edges.service'
import { createPreviewTokenService, consumePreviewTokenService } from '../../../services/preview-tokens.service'
import { itemEnvelope } from '../envelope'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

function edgeFingerprint(edge: { id: string; source_id: string; target_id: string; type: string; created_at: string }, newType: string): string {
  return `${edge.id}:${edge.source_id}:${edge.target_id}:${edge.type}:${edge.created_at}:${newType}`
}

export const retypeHandler: ActionHandler = {
  input: z.object({
    edge_id: requiredString('edge_id is required for retype action'),
    new_type: z.enum(EDGE_TYPES),
    preview_token: z.string().optional()
  }),
  run(args: ActionArgs) {
    const edgeId = args.edge_id as string
    const newType = args.new_type as string
    const confirm = args.confirm === true
    const previewToken = args.preview_token as string | undefined

    // Dry-run and confirm run the SAME validation (ADR §2): the preview
    // must never promise a confirm would reject.
    const edge = validateRetypeService(edgeId, newType)

    if (!confirm) {
      const token = createPreviewTokenService('retype', edgeId, edgeFingerprint(edge, newType))
      return itemEnvelope(
        'retype',
        {
          status: 'preview',
          edge_id: edgeId,
          old_edge_id: edgeId,
          old_type: edge.type,
          new_type: newType,
          source_id: edge.source_id,
          target_id: edge.target_id,
          consequence: `Changes edge type from '${edge.type}' to '${newType}'.`,
          preview_token: token
        },
        { preview: { token } }
      )
    }

    const currentFingerprint = edgeFingerprint(edge, newType)
    if (!previewToken) throw new Error('preview_token is required')
    const verification = consumePreviewTokenService(previewToken, 'retype', edgeId, currentFingerprint)
    if (!verification.valid) throw new Error(`preview token ${verification.reason ?? 'invalid'}`)

    const oldType = edge.type
    const retyped = retypeEdgeService(edgeId, newType)
    // retypeEdge does delete+insert, so the id changes — return the fresh
    // id so a chained unlink/retype resolves. Keep `edge_id` (new id) for
    // backward compatibility and expose both ids for traceability.
    return itemEnvelope('retype', {
      status: 'retyped',
      edge_id: retyped.id,
      old_edge_id: edgeId,
      new_edge_id: retyped.id,
      old_type: oldType,
      new_type: newType
    })
  }
}
