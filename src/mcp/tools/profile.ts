import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getProfileService } from '../../services/profile.service'
import { jsonResult, errorResult } from './utils'

export function registerProfileTools(server: McpServer) {
  server.tool('get_profile', 'Get user profile stats and thoughts', {}, async () => {
    try {
      const { stats, thoughts } = getProfileService()
      return jsonResult({ stats, thoughts })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'Failed to get profile')
    }
  })
}
