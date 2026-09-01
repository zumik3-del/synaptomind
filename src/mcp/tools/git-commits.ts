import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { indexProjectCommits } from '../../services/git_commits.service'
import { jsonResult, errorResult } from './utils'

export function registerGitCommitTools(server: McpServer) {
  server.tool('git_index_commits', 'Index git history for search', {
    project_id: z.string().describe('Project ID (must have git_repo_url set)'),
    limit: z.number().optional().describe('Max commits to index'),
    since_hash: z.string().optional().describe('Index since this hash')
  }, async (args) => {
    try {
      const result = await indexProjectCommits(args.project_id, { limit: args.limit, since_hash: args.since_hash })
      return jsonResult(result)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'Failed to index git commits')
    }
  })
}
