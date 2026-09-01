import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getFrontier } from '../../services/frontier.service'
import { jsonResult, errorResult } from './utils'

export function registerFrontierTools(server: McpServer) {
  server.tool('get_frontier', 'Get "what to do next" ranking', {
    project_id: z.string().optional().describe('Filter by project'),
    k: z.number().optional().describe('Max results (default 10)')
  }, async (args) => {
    try {
      const frontier = getFrontier({ project_id: args.project_id, k: args.k })
      return jsonResult(frontier)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'Failed to get frontier')
    }
  })
}
