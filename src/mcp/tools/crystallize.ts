import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { crystallize } from '../../services/crystals.service'
import { getGraphDataService } from '../../services/graph.service'
import { createClusterService, removeClusterMemberService, dissolveClusterService, getClusterThoughtService, listClusterMembersService, findClusterMemberEdgeService } from '../../services/cluster.service'
import { runAutoClusterJob } from '../../services/auto-cluster.service'
import { resolveProjectId } from './utils'
import { registerActionTool, requiredString, type ActionArgs } from './action-tool'

/**
 * Normalize an optional numeric argument that may arrive as a number or as a
 * numeric string (MCP clients differ in how they serialize numbers). Returns
 * `undefined` for absent/blank/non-finite values so the service falls back to
 * `config.autoCluster.*` defaults.
 */
function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** Normalize an optional boolean argument, tolerating `'true'`/`'false'` strings. */
function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

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
      return runAutoClusterJob({
        minAgeDays: optionalNumber(args.min_age_days),
        minSimilarity: optionalNumber(args.min_similarity),
        minMembers: optionalNumber(args.min_members),
        dryRun: optionalBoolean(args.dry_run)
      })
    }
  },

  cluster_remove: {
    input: z.object({
      cluster_id: requiredString('cluster_id is required for cluster_remove action'),
      thought_id: requiredString('thought_id is required for cluster_remove action')
    }),
    run(args: ActionArgs) {
      const clusterId = args.cluster_id as string
      const thoughtId = args.thought_id as string
      const confirm = args.confirm === true

      if (!confirm) {
        const cluster = getClusterThoughtService(clusterId)
        if (!cluster) throw new Error(`Cluster not found: ${clusterId}`)
        const edgeId = findClusterMemberEdgeService(clusterId, thoughtId)
        if (!edgeId) throw new Error(`Thought ${thoughtId} is not a member of cluster ${clusterId}`)
        return {
          status: 'preview',
          cluster_id: clusterId,
          thought_id: thoughtId,
          edge_id: edgeId,
          consequence: `Removes '${thoughtId}' from cluster '${clusterId}'. The thought becomes standalone.`
        }
      }

      const result = removeClusterMemberService({ clusterId, thoughtId })
      return { status: 'removed', cluster_id: result.clusterId, thought_id: result.thoughtId, edge_id: result.edgeId }
    }
  },

  cluster_dissolve: {
    input: z.object({
      cluster_id: requiredString('cluster_id is required for cluster_dissolve action')
    }),
    run(args: ActionArgs) {
      const clusterId = args.cluster_id as string
      const confirm = args.confirm === true

      if (!confirm) {
        const cluster = getClusterThoughtService(clusterId)
        if (!cluster) throw new Error(`Cluster not found: ${clusterId}`)
        const members = listClusterMembersService(clusterId)
        return {
          status: 'preview',
          cluster_id: clusterId,
          member_count: members.length,
          member_ids: members.map(m => m.id),
          consequence: `Deletes the cluster thought and ${members.length} member edges. Member thoughts become standalone.`
        }
      }

      const result = dissolveClusterService({ clusterId })
      return { status: 'dissolved', cluster_id: result.clusterId, deleted_edge_count: result.deletedEdgeCount, deleted_member_count: 0 }
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
- auto_cluster: Batch auto-clustering (Union-Find based)
- cluster_remove: Remove a member from a cluster (dry-run with confirm=false, then confirm=true)
- cluster_dissolve: Dissolve an entire cluster (dry-run with confirm=false, then confirm=true)`,
    inputSchema: {
      action: z.enum(['crystallize', 'graph', 'cluster', 'auto_cluster', 'cluster_remove', 'cluster_dissolve']).describe('Action'),
      thought_ids: z.array(z.string()).optional().describe('Thought IDs to crystallize (required for cluster action)'),
      cluster_id: z.string().optional().describe('Cluster ID to crystallize (required for cluster_remove and cluster_dissolve)'),
      style: z.enum(['runbook', 'decision-log', 'overview']).optional().describe('Output style (crystallize only)'),
      project_id: z.string().optional().describe('Project ID (crystallize/graph/cluster only; auto_cluster operates globally)'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project (crystallize/graph/cluster only; auto_cluster operates globally)'),
      status: z.string().optional().describe('Filter by status (default: active, graph only)'),
      limit: z.coerce.number().int().min(1).max(2000).optional().describe('Max nodes to return (default 500, 1-2000; graph only)'),
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
