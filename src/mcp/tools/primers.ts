import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { listPrimersService, getPrimerService, deletePrimerService } from '../../services/primers.service'
import { createPreviewTokenService, consumePreviewTokenService } from '../../services/preview-tokens.service'
import { registerActionTool, requiredString, type ActionArgs } from './action-tool'

function primerFingerprint(primer: { id: string; thought_id: string; hit_count: number; promoted_at: string | null; created_at: string }): string {
  return `${primer.id}:${primer.thought_id}:${primer.hit_count}:${primer.promoted_at ?? ''}:${primer.created_at}`
}

const handlers = {
  list: {
    run() {
      return listPrimersService()
    }
  },

  delete: {
    input: z.object({ primer_id: requiredString('primer_id is required for delete action'), preview_token: z.string().optional() }),
    run(args: ActionArgs) {
      const primerId = args.primer_id as string
      const confirm = args.confirm === true
      const previewToken = args.preview_token as string | undefined

      if (!confirm) {
        const primer = getPrimerService(primerId)
        if (!primer) return { status: 'not_found', primer_id: primerId }
        const token = createPreviewTokenService('primer_delete', primerId, primerFingerprint(primer))
        return {
          status: 'preview',
          primer_id: primerId,
          primer: {
            id: primer.id,
            thought_id: primer.thought_id,
            hit_count: primer.hit_count,
            promoted_at: primer.promoted_at,
            created_at: primer.created_at
          },
          consequence: `Removes the primer for thought '${primer.thought_id}' from the always-at-hand set.`,
          instruction: `Call memory_primers again with action=delete, primer_id=${primerId}, confirm=true to proceed.`,
          preview_token: token
        }
      }

      const primer = getPrimerService(primerId)
      if (primer) {
        const fp = primerFingerprint(primer)
        if (!previewToken) throw new Error('preview_token is required')
        const verification = consumePreviewTokenService(previewToken, 'primer_delete', primerId, fp)
        if (!verification.valid) throw new Error(`preview token ${verification.reason ?? 'invalid'}`)
      }

      const deleted = deletePrimerService(primerId)
      return { status: deleted ? 'deleted' : 'not_found', primer_id: primerId }
    }
  }
}

export function registerMemoryPrimers(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_primers',
    description: `Manage primers (the always-at-hand set). Actions: list, delete (preview→confirm).`,
    inputSchema: {
      action: z.enum(['list', 'delete']).describe('Action'),
      primer_id: z.string().optional().describe('REQUIRED for "delete". Primer ID. IGNORED for "list".'),
      confirm: z.boolean().optional().describe('CONSUMED by "delete" (true executes; false/omitted previews). IGNORED for "list".'),
      preview_token: z.string().optional().describe('OPTIONAL preview token returned by a prior preview. CONSUMED by "delete" (true executes with token validation; missing/stale fails). IGNORED for "list".')
    },
    handlers
  })
}