import { z } from 'zod/v4'
import { deleteEdgeService, findEdgeService } from '../../../services/edges.service'
import { createPreviewTokenService, consumePreviewTokenService } from '../../../services/preview-tokens.service'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

function edgeFingerprint(edge: { id: string; source_id: string; target_id: string; type: string; created_at: string }): string {
  return `${edge.id}:${edge.source_id}:${edge.target_id}:${edge.type}:${edge.created_at}`
}

export const unlinkHandler: ActionHandler = {
  input: z.object({
    edge_id: requiredString('edge_id is required for unlink action'),
    preview_token: z.string().optional()
  }),
  run(args: ActionArgs) {
    const edgeId = args.edge_id as string
    const confirm = args.confirm === true
    const previewToken = args.preview_token as string | undefined

    if (!confirm) {
      const edge = findEdgeService(edgeId)
      if (!edge) return { status: 'not_found', edge_id: edgeId }
      const token = createPreviewTokenService('unlink', edgeId, edgeFingerprint(edge))
      return {
        status: 'preview',
        edge_id: edgeId,
        edge: { id: edge.id, source_id: edge.source_id, target_id: edge.target_id, type: edge.type, created_at: edge.created_at },
        consequence: `Removes the '${edge.type}' edge between '${edge.source_id}' and '${edge.target_id}'.`,
        preview_token: token,
        instruction: `Call memory_store again with action=unlink, edge_id=${edgeId}, confirm=true to proceed.`
      }
    }

    const edge = findEdgeService(edgeId)
    if (edge) {
      const currentFingerprint = edgeFingerprint(edge)
      if (!previewToken) throw new Error('preview_token is required')
      const verification = consumePreviewTokenService(previewToken, 'unlink', edgeId, currentFingerprint)
      if (!verification.valid) throw new Error(`preview token ${verification.reason ?? 'invalid'}`)
    }

    const deleted = deleteEdgeService(edgeId)
    return { status: deleted ? 'deleted' : 'not_found', edge_id: edgeId }
  }
}