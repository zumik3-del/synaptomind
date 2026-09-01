import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { listPrimersService, deletePrimerService } from '../../services/primers.service'
import { jsonResult, errorResult } from './utils'

export function registerPrimerTools(server: McpServer) {
  server.tool('manage_primers', 'List or delete primers', {
    action: z.enum(['list', 'delete']).describe('Action: list, delete'),
    primer_id: z.string().optional().describe('Primer ID to delete')
  }, async (args) => {
    if (args.action === 'list') {
      const primers = listPrimersService()
      return jsonResult(primers)
    }
    if (args.action === 'delete') {
      if (!args.primer_id) return errorResult('primer_id required for delete')
      const deleted = deletePrimerService(args.primer_id)
      return jsonResult({ deleted })
    }
    return errorResult('Invalid action')
  })
}
