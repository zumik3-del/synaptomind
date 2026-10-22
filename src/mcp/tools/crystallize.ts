import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { graphLimitSchema, graphOffsetSchema, graphStatusSchema } from '../../validation'
import { registerActionTool } from './action-tool'
import { graphHandler } from './crystallize/graph'
import { clusterHandler } from './crystallize/cluster'
import { autoClusterHandler } from './crystallize/auto-cluster'

const handlers = {
  graph: graphHandler,
  cluster: clusterHandler,
  auto_cluster: autoClusterHandler
}

export function registerMemoryCrystallize(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_crystallize',
    description: `Visualize and reorganize clusters. Actions: graph, cluster, auto_cluster (Union-Find).`,
    inputSchema: {
      action: z.enum(['graph', 'cluster', 'auto_cluster']).describe('Action'),
      thought_ids: z.array(z.string()).optional().describe('Thought IDs (required for cluster action)'),
      project_id: z.string().optional().describe('Project ID (graph/cluster only; auto_cluster operates globally)'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project (graph/cluster only; auto_cluster operates globally)'),
      status: graphStatusSchema.optional().describe('Filter by status (default: active, graph only)'),
      limit: graphLimitSchema.optional().describe('Max nodes to return (default 500, 1-2000; graph only)'),
      offset: graphOffsetSchema.optional().describe('Offset for pagination (default 0, 0-1000000; graph only)'),
      title: z.string().optional().describe('Cluster title (cluster only)'),
      tags: z.array(z.string()).optional().describe('Tags (cluster only)'),
      min_age_days: z.coerce.number().int().min(0).max(3650).optional().describe('Min age in days (auto_cluster only)'),
      min_similarity: z.coerce.number().min(0).max(1).optional().describe('Min similarity threshold 0-1 (auto_cluster only)'),
      min_members: z.coerce.number().int().min(1).max(1000).optional().describe('Min members per cluster (auto_cluster only)'),
      dry_run: z.boolean().optional().describe('Dry run mode (auto_cluster only)')
    },
    handlers
  })
}
