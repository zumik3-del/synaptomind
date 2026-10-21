import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { listPrimersService, getPrimerService, deletePrimerService } from '../../services/primers.service'
import { registerActionTool, requiredString, type ActionArgs } from './action-tool'

const handlers = {
  list: {
    run() {
      return listPrimersService()
    }
  },

  delete: {
    input: z.object({ primer_id: requiredString('primer_id is required for delete action') }),
    run(args: ActionArgs) {
      const primerId = args.primer_id as string
      const confirm = args.confirm === true

      if (!confirm) {
        const primer = getPrimerService(primerId)
        if (!primer) return { status: 'not_found', primer_id: primerId }
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
          instruction: `Call memory_primers again with action=delete, primer_id=${primerId}, confirm=true to proceed.`
        }
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
      primer_id: z.string().optional().describe('REQUIRED for "delete".'),
      confirm: z.boolean().optional().describe('delete: set true to actually delete. Set to false to preview first.')
    },
    handlers
  })
}
