import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { crystallize } from '../../services/crystals.service'
import { jsonResult, errorResult } from './utils'

export function registerCrystalTools(server: McpServer) {
  server.tool('crystallize', 'Compress thoughts into markdown (runbook, decision-log, or overview)', {
    thought_ids: z.array(z.string()).optional().describe('Thought IDs to crystallize'),
    cluster_id: z.string().optional().describe('Cluster ID to crystallize'),
    style: z.enum(['runbook', 'decision-log', 'overview']).optional().describe('Output style: runbook, decision-log, overview'),
    project_id: z.string().optional().describe('Project ID')
  }, async (args) => {
    try {
      const result = crystallize({ thought_ids: args.thought_ids, cluster_id: args.cluster_id, style: args.style, project_id: args.project_id })
      return jsonResult(result)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'Crystallize failed')
    }
  })
}
