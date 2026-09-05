import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { crystallize } from '../../services/crystals.service'
import { getGraphDataService } from '../../services/graph.service'
import { createClusterService } from '../../services/cluster.service'
import { runAutoClusterJob } from '../../services/auto-cluster.service'
import { jsonResult, errorResult } from './utils'

export function registerMemoryCrystallize(server: McpServer) {
  server.tool('memory_crystallize', `Consolidate and visualize thoughts. Actions:
- crystallize: Compress thoughts/clusters into markdown (runbook, decision-log, or overview)
- graph: Return all thoughts and edges as a graph
- cluster: Create a cluster from thought IDs
- auto_cluster: Batch auto-clustering (Union-Find based)`, {
    action: z.enum(['crystallize', 'graph', 'cluster', 'auto_cluster']).describe('Action'),
    thought_ids: z.array(z.string()).optional().describe('Thought IDs to crystallize'),
    cluster_id: z.string().optional().describe('Cluster ID to crystallize'),
    style: z.enum(['runbook', 'decision-log', 'overview']).optional().describe('Output style (crystallize only)'),
    project_id: z.string().optional().describe('Project ID'),
    status: z.string().optional().describe('Filter by status (default: active, graph only)'),
    title: z.string().optional().describe('Cluster title (cluster only)'),
    tags: z.array(z.string()).optional().describe('Tags (cluster only)'),
    min_age_days: z.number().optional().describe('Min age in days (auto_cluster only)'),
    min_similarity: z.number().optional().describe('Min similarity threshold (auto_cluster only)'),
    min_members: z.number().optional().describe('Min members per cluster (auto_cluster only)'),
    dry_run: z.boolean().optional().describe('Dry run mode (auto_cluster only)')
  }, async (args) => {
    try {
      if (args.action === 'crystallize') {
        const result = crystallize({ thought_ids: args.thought_ids, cluster_id: args.cluster_id, style: args.style, project_id: args.project_id })
        return jsonResult(result)
      }

      if (args.action === 'graph') {
        const graph = getGraphDataService(args.project_id, args.status)
        return jsonResult(graph)
      }

      if (args.action === 'cluster') {
        if (!args.thought_ids || args.thought_ids.length === 0) return errorResult('thought_ids is required for cluster action')
        const result = createClusterService({ thoughtIds: args.thought_ids, title: args.title, tags: args.tags, projectId: args.project_id })
        return jsonResult(result)
      }

      if (args.action === 'auto_cluster') {
        const result = await runAutoClusterJob({ minAgeDays: args.min_age_days, minSimilarity: args.min_similarity, minMembers: args.min_members, dryRun: args.dry_run })
        return jsonResult(result)
      }

      return errorResult(`Unknown action: ${args.action}`)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'memory_crystallize failed')
    }
  })
}
