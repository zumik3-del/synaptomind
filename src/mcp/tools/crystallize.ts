import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { graphLimitSchema, graphStatusSchema } from '../../validation'
import { registerActionTool } from './action-tool'
import { graphHandler } from './crystallize/graph'
import { clusterHandler } from './crystallize/cluster'
import { autoClusterHandler } from './crystallize/auto-cluster'
import { clusterRemoveHandler } from './crystallize/cluster-remove'
import { clusterDissolveHandler } from './crystallize/cluster-dissolve'

const handlers = {
  graph: graphHandler,
  cluster: clusterHandler,
  auto_cluster: autoClusterHandler,
  cluster_remove: clusterRemoveHandler,
  cluster_dissolve: clusterDissolveHandler
}

export function registerMemoryCrystallize(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_crystallize',
    description: `Consolidate and visualize thoughts. Actions:
- graph: Return all thoughts and edges as a graph
- cluster: Create a cluster from thought IDs
- auto_cluster: Batch auto-clustering (Union-Find based)
- cluster_remove: Remove a member from a cluster (dry-run with confirm=false, then confirm=true)
- cluster_dissolve: Dissolve an entire cluster (dry-run with confirm=false, then confirm=true)`,
    inputSchema: {
      action: z.enum(['graph', 'cluster', 'auto_cluster', 'cluster_remove', 'cluster_dissolve']).describe('Action'),
      thought_ids: z.array(z.string()).optional().describe('Thought IDs (required for cluster action)'),
      cluster_id: z.string().optional().describe('Cluster ID (required for cluster_remove and cluster_dissolve)'),
      project_id: z.string().optional().describe('Project ID (graph/cluster only; auto_cluster operates globally)'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project (graph/cluster only; auto_cluster operates globally)'),
      status: graphStatusSchema.optional().describe('Filter by status (default: active, graph only)'),
      limit: graphLimitSchema.optional().describe('Max nodes to return (default 500, 1-2000; graph only)'),
      title: z.string().optional().describe('Cluster title (cluster only)'),
      tags: z.array(z.string()).optional().describe('Tags (cluster only)'),
      min_age_days: z.coerce.number().int().min(0).max(3650).optional().describe('Min age in days (auto_cluster only)'),
      min_similarity: z.coerce.number().min(0).max(1).optional().describe('Min similarity threshold 0-1 (auto_cluster only)'),
      min_members: z.coerce.number().int().min(1).max(1000).optional().describe('Min members per cluster (auto_cluster only)'),
      dry_run: z.boolean().optional().describe('Dry run mode (auto_cluster only)'),
      thought_id: z.string().optional().describe('REQUIRED for "cluster_remove". The thought to remove from the cluster.'),
      confirm: z.boolean().optional().describe('cluster_remove/cluster_dissolve: set true to execute the write; absent/false is a non-mutating dry-run')
    },
    handlers
  })
}
