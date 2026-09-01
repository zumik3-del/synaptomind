import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getSlots } from '../../services/slots.service'
import { resolveProjectService } from '../../services/projects.service'
import { jsonResult, errorResult } from './utils'

export function registerSlotTools(server: McpServer) {
  server.tool('get_slots', 'Get context slots: persona, pending_items, architecture_decisions, project_context, active_goals', {
    names: z.array(z.string()).optional().describe('Filter by slot names'),
    project_id: z.string().optional().describe('Filter by project'),
    cwd: z.string().optional().describe('Working directory to auto-resolve project when project_id is not provided')
  }, async (args) => {
    try {
      let projectId = args.project_id
      if (!projectId && args.cwd) {
        const project = resolveProjectService(args.cwd)
        if (project) projectId = project.id
      }
      const slots = getSlots({ names: args.names, projectId })
      return jsonResult(slots)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'Failed to get slots')
    }
  })
}
