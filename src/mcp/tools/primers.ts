import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import {
  listPrimersService,
  getPrimerService,
  deletePrimerService
} from '../../services/primers.service'
import { fingerprintOf, runGuarded } from '../../services/confirm-gate.service'
import { collectionEnvelope, itemEnvelope } from './envelope'
import { registerActionTool, requiredString, type ActionArgs } from './action-tool'

const handlers = {
  list: {
    run() {
      return collectionEnvelope('list', listPrimersService())
    }
  },

  delete: {
    input: z.object({
      primer_id: requiredString('primer_id is required for delete action'),
      preview_token: z.string().optional()
    }),
    async run(args: ActionArgs) {
      const primerId = args.primer_id as string
      const primer = getPrimerService(primerId)
      if (!primer) return itemEnvelope('delete', { status: 'not_found', primer_id: primerId })

      const outcome = await runGuarded(args, {
        kind: 'primer_delete',
        targetId: primerId,
        fingerprint: () =>
          fingerprintOf(
            primer.id,
            primer.thought_id,
            primer.hit_count,
            primer.promoted_at,
            primer.created_at
          ),
        preview: token => {
          const consequence = `Removes the primer for thought '${primer.thought_id}' from the always-at-hand set.`
          const instruction = `Call memory_primers again with action=delete, primer_id=${primerId}, confirm=true to proceed.`
          return itemEnvelope(
            'delete',
            {
              status: 'preview',
              primer_id: primerId,
              primer: {
                id: primer.id,
                thought_id: primer.thought_id,
                hit_count: primer.hit_count,
                promoted_at: primer.promoted_at,
                created_at: primer.created_at
              },
              consequence,
              instruction,
              preview_token: token
            },
            { preview: { token, consequence, instruction } }
          )
        },
        apply: () =>
          itemEnvelope('delete', {
            status: deletePrimerService(primerId) ? 'deleted' : 'not_found',
            primer_id: primerId
          })
      })
      return outcome.value
    }
  }
}

export function registerMemoryPrimers(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_primers',
    description: `Manage primers (the always-at-hand set). Answers the shared envelope: { items, meta } for list and { item, meta } for delete; a preview sets meta.preview={token,destructive:true}. Actions: list, delete (preview→confirm).`,
    inputSchema: {
      action: z.enum(['list', 'delete']).describe('Action'),
      primer_id: z
        .string()
        .optional()
        .describe('REQUIRED for "delete". Primer ID. IGNORED for "list".'),
      confirm: z
        .boolean()
        .optional()
        .describe(
          'CONSUMED by "delete" (true executes; false/omitted previews). IGNORED for "list".'
        ),
      preview_token: z
        .string()
        .optional()
        .describe(
          'OPTIONAL preview token returned by a prior preview. CONSUMED by "delete" (true executes with token validation; missing/stale fails). IGNORED for "list".'
        )
    },
    handlers
  })
}
