import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import {
  listPrimersService,
  getPrimerService,
  deletePrimerService
} from '../../services/primers.service'
import { fingerprintOf, runGuarded } from '../../services/confirm-gate.service'
import { collectionEnvelope, itemEnvelope } from './envelope'
import { actionInput, registerActionTool, requiredString, type ActionArgs } from './action-tool'

const PRIMERS_ARGS = {
  primer_id: z
    .string()
    .optional()
    .describe('REQUIRED for "delete". Primer ID. REJECTED for "list".'),
  confirm: z
    .boolean()
    .optional()
    .describe('CONSUMED by "delete" (true executes; false/omitted previews). REJECTED for "list".'),
  preview_token: z
    .string()
    .optional()
    .describe(
      'OPTIONAL preview token returned by a prior preview. CONSUMED by "delete" (true executes with token validation; missing/stale fails). REJECTED for "list".'
    )
}

const handlers = {
  list: {
    input: actionInput(PRIMERS_ARGS, []),
    run() {
      return collectionEnvelope('list', listPrimersService())
    }
  },

  delete: {
    input: actionInput(PRIMERS_ARGS, ['primer_id', 'confirm', 'preview_token'], {
      primer_id: requiredString('primer_id is required for delete action')
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
              instruction
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
    description: `The always-at-hand set — thoughts recalled often enough to be injected into every conversation — and the only tool that reviews or removes them. Answers the shared envelope ({ items, meta } for list, { item, meta } for delete) and refuses an argument that belongs to the other action.

Primers are created automatically, never by this tool: a thought is promoted on the search path once its hit count reaches primer.promoteThreshold (default 5). list returns them most-hit first (up to 500) as { id, thought_id, hit_count, promoted_at, created_at } — read a primer's text with memory_recall action=get thought_id=<primer.thought_id>, project context and active goals with memory_status action=slots, and clusters with memory_crystallize.

delete removes the primer record only: the thought, its edges and its history stay. It is preview-first — without confirm=true it answers a preview carrying consequence, instruction and meta.preview.token, and confirm=true must echo that token back; a missing, stale or mismatched token fails with an error and needs a fresh preview. Deletion is not permanent: the same thought is promoted again the next time it is recalled while its hit count still reaches the threshold. An unknown primer_id answers status=not_found as an ordinary item rather than an error.`,
    inputSchema: {
      action: z.enum(['list', 'delete']).describe('Action'),
      ...PRIMERS_ARGS
    },
    handlers
  })
}
