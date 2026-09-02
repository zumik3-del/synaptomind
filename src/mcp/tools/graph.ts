import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getGraphDataService, getChainService, getContextService } from '../../services/graph.service'
import { searchThoughts } from '../../services/search.service'
import { createClusterService } from '../../services/cluster.service'
import { runAutoClusterJob } from '../../services/auto-cluster.service'
import { createEdgeService } from '../../services/edges.service'
import { mergeThoughtsService } from '../../services/thoughts.service'
import { jsonResult, errorResult } from './utils'

export function registerGraphTools(server: McpServer) {
  server.tool('get_thought_graph', 'Return all thoughts and edges as a graph', {
    project_id: z.string().optional().describe('Filter by project'),
    status: z.string().optional().describe('Filter by status (default: active)')
  }, async (args) => {
    const graph = getGraphDataService(args.project_id, args.status)
    return jsonResult(graph)
  })

  server.tool('recall_clusters', 'Search clusters by semantic similarity', {
    query: z.string().describe('Search query'),
    k: z.number().optional().describe('Max results (default 10)'),
    project_id: z.string().optional().describe('Filter by project')
  }, async (args) => {
    const results = await searchThoughts({
      query: args.query,
      topK: args.k,
      clusterFilter: 'only',
      projectFilter: args.project_id
    })
    return jsonResult(results)
  })

  server.tool('cluster', 'Create a cluster from thought IDs', {
    thought_ids: z.array(z.string()).describe('Thought IDs to cluster'),
    title: z.string().optional().describe('Cluster title'),
    tags: z.array(z.string()).optional().describe('Tags'),
    project_id: z.string().optional().describe('Project ID')
  }, async (args) => {
    const result = createClusterService({ thoughtIds: args.thought_ids, title: args.title, tags: args.tags, projectId: args.project_id })
    return jsonResult(result)
  })

  server.tool('auto_cluster', 'Batch auto-clustering', {
    min_age_days: z.number().optional().describe('Min age in days'),
    min_similarity: z.number().optional().describe('Min similarity threshold'),
    min_members: z.number().optional().describe('Min members per cluster'),
    dry_run: z.boolean().optional().describe('Dry run mode')
  }, async (args) => {
    const result = await runAutoClusterJob({ minAgeDays: args.min_age_days, minSimilarity: args.min_similarity, minMembers: args.min_members, dryRun: args.dry_run })
    return jsonResult(result)
  })

  server.tool('get_chain', 'Traverse linked thoughts from a starting point', {
    thought_id: z.string().describe('Thought ID'),
    direction: z.enum(['upstream', 'downstream', 'both']).optional().describe('Traversal direction: upstream, downstream, both')
  }, async (args) => {
    const chain = getChainService(args.thought_id, args.direction)
    if (!chain) return errorResult(`Thought '${args.thought_id}' not found`)
    return jsonResult(chain)
  })

  server.tool('get_context', 'Find best matching thought and return its chain context', {
    query: z.string().describe('Search query')
  }, async (args) => {
    const context = getContextService(args.query)
    if (!context) return errorResult(`No thoughts matching '${args.query}'`)
    return jsonResult(context)
  })

  server.tool('link_thoughts', 'Create a directed edge between thoughts', {
    source_id: z.string().describe('Source thought ID'),
    target_id: z.string().describe('Target thought ID'),
    type: z.enum(['related', 'parent', 'develops', 'replaces', 'cluster', 'references', 'depends_on']).optional().describe('Edge type: related (default) — general association; parent — hierarchical sub-thought; develops — conceptual evolution; replaces — supersedes outdated thought; cluster — A contains B as member; references — mutual link between clusters; depends_on — A blocked until B done')
  }, async (args) => {
    const edge = createEdgeService(args.source_id, args.target_id, args.type)
    return jsonResult(edge)
  })

  server.tool('merge_thoughts', 'Merge source into target (source archived, target updated)', {
    source_id: z.string().describe('Source thought ID (will be archived)'),
    target_id: z.string().describe('Target thought ID (will be updated)'),
    merged_content: z.string().optional().describe('Merged content'),
    merged_tags: z.array(z.string()).optional().describe('Merged tags'),
    project_id: z.string().optional().describe('Project ID')
  }, async (args) => {
    const result = mergeThoughtsService(args.source_id, args.target_id, args.merged_content, args.merged_tags, args.project_id)
    return jsonResult(result)
  })
}
