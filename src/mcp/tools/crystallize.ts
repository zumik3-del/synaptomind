import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { crystallize } from '../../services/crystals.service'
import { getGraphDataService } from '../../services/graph.service'
import { createClusterService } from '../../services/cluster.service'
import { runAutoClusterJob } from '../../services/auto-cluster.service'
import { resolveProjectId } from './utils'
import { registerActionTool, type ActionArgs } from './action-tool'

const handlers = {
  crystallize: {
    run(args: ActionArgs) {
      const projectId = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
      return crystallize({ thought_ids: args.thought_ids as string[] | undefined, cluster_id: args.cluster_id as string | undefined, style: args.style as 'runbook' | 'decision-log' | 'overview' | undefined, project_id: projectId })
    }
  },

  graph: {
    run(args: ActionArgs) {
      const projectId = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
      return getGraphDataService(projectId, args.status as string | undefined, args.limit as number | undefined)
    }
  },

  cluster: {
    input: z.object({
      thought_ids: z
        .array(z.string(), { error: 'thought_ids is required for cluster action' })
        .min(1, 'thought_ids is required for cluster action')
    }),
    run(args: ActionArgs) {
      const projectId = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
      return createClusterService({ thoughtIds: args.thought_ids as string[], title: args.title as string | undefined, tags: args.tags as string[] | undefined, projectId })
    }
  },

  auto_cluster: {
    // auto_cluster is a global operation and must not resolve or warn about a project.
    async run(args: ActionArgs) {
      return runAutoClusterJob({ minAgeDays: args.min_age_days as number | undefined, minSimilarity: args.min_similarity as number | undefined, minMembers: args.min_members as number | undefined, dryRun: args.dry_run as boolean | undefined })
    }
  }
}

export function registerMemoryCrystallize(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_crystallize',
    description: `Consolidate and visualize thoughts. Actions:
- crystallize: Compress thoughts/clusters into markdown (runbook, decision-log, or overview)
- graph: Return all thoughts and edges as a graph
- cluster: Create a cluster from thought IDs
- auto_cluster: Batch auto-clustering (Union-Find based)`,
    inputSchema: {
      action: z.enum(['crystallize', 'graph', 'cluster', 'auto_cluster']).describe('Action'),
      thought_ids: z.array(z.string()).optional().describe('Thought IDs to crystallize (required for cluster action)'),
      cluster_id: z.string().optional().describe('Cluster ID to crystallize'),
      style: z.enum(['runbook', 'decision-log', 'overview']).optional().describe('Output style (crystallize only)'),
      project_id: z.string().optional().describe('Project ID (crystallize/graph/cluster only; auto_cluster operates globally)'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project (crystallize/graph/cluster only; auto_cluster operates globally)'),
      status: z.string().optional().describe('Filter by status (default: active, graph only)'),
      limit: z.number().int().min(1).max(2000).optional().describe('Max nodes to return (default 500, 1-2000; graph only)'),
      title: z.string().optional().describe('Cluster title (cluster only)'),
      tags: z.array(z.string()).optional().describe('Tags (cluster only)'),
      min_age_days: z.number().int().min(0).max(3650).optional().describe('Min age in days (auto_cluster only)'),
      min_similarity: z.number().min(0).max(1).optional().describe('Min similarity threshold 0-1 (auto_cluster only)'),
      min_members: z.number().int().min(1).max(1000).optional().describe('Min members per cluster (auto_cluster only)'),
      dry_run: z.boolean().optional().describe('Dry run mode (auto_cluster only)')
    },
    handlers
  })
}
