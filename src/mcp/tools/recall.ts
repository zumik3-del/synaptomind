import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { searchThoughts, searchThoughtsGrouped } from '../../services/search.service'
import { postProcessSearchResults } from '../../services/search_postprocess.service'
import { getChainService, getContextService } from '../../services/graph.service'
import { getThoughtById } from '../../services/thoughts.service'
import { resolveProjectService } from '../../services/projects.service'
import { jsonResult, errorResult } from './utils'

function resolveProjectId(projectId?: string, cwd?: string): string | undefined {
  if (projectId) return projectId
  if (cwd) {
    const project = resolveProjectService(cwd)
    if (project) return project.id
  }
  return undefined
}

export function registerMemoryRecall(server: McpServer) {
  server.tool('memory_recall', `Search and retrieve thoughts. Actions:
- search: Hybrid/vector/BM25 search across thoughts (default)
- get: Get a single thought by ID
- context: Find best matching thought and return its chain context
- chain: Traverse linked thoughts from a starting point
- clusters: Search clusters by semantic similarity`, {
    action: z.enum(['search', 'get', 'context', 'chain', 'clusters']).optional().describe('Action (default: search)'),
    query: z.string().describe('Search query (required for search/context/clusters, not for chain)'),
    top_k: z.number().optional().describe('Max results (default 10)'),
    status: z.string().optional().describe('Filter by status'),
    project_id: z.string().optional().describe('Filter by project (prefer cwd instead)'),
    cwd: z.string().optional().describe('Working directory — auto-resolves project. Always pass this.'),
    tag: z.string().optional().describe('Filter by tag'),
    cluster: z.enum(['only', 'exclude']).optional().describe('Cluster filter: only (clusters only), exclude (exclude clusters)'),
    group_by_cluster: z.boolean().optional().describe('Group results by cluster'),
    min_importance: z.number().optional().describe('Minimum importance'),
    exclude_flagged: z.boolean().optional().describe('Exclude flagged thoughts'),
    hybrid: z.boolean().optional().describe('Use hybrid search'),
    thought_id: z.string().optional().describe('Thought ID (required for chain action)'),
    direction: z.enum(['upstream', 'downstream', 'both']).optional().describe('Traversal direction (default: both)')
  }, async (args) => {
    const action = args.action ?? 'search'
    const projectFilter = resolveProjectId(args.project_id, args.cwd)

    try {
      if (action === 'get') {
        if (!args.thought_id) return errorResult('thought_id is required for get action')
        const thought = getThoughtById(args.thought_id)
        if (!thought) return errorResult(`Thought '${args.thought_id}' not found`)
        return jsonResult(thought)
      }

      if (action === 'search') {
        const topK = args.top_k ?? 10
        const results = args.group_by_cluster
          ? await searchThoughtsGrouped({
              query: args.query, topK, statusFilter: args.status,
              projectFilter, tagFilter: args.tag, clusterFilter: args.cluster,
              minImportance: args.min_importance, excludeFlagged: args.exclude_flagged,
              hybrid: args.hybrid
            })
          : await searchThoughts({
              query: args.query, topK, statusFilter: args.status,
              projectFilter, tagFilter: args.tag, clusterFilter: args.cluster,
              minImportance: args.min_importance, excludeFlagged: args.exclude_flagged,
              hybrid: args.hybrid
            })
        const processed = postProcessSearchResults(results, { query: args.query, topK, showPrimers: true })
        return jsonResult(processed)
      }

      if (action === 'context') {
        const context = getContextService(args.query)
        if (!context) return errorResult(`No thoughts matching '${args.query}'`)
        return jsonResult(context)
      }

      if (action === 'chain') {
        if (!args.thought_id) return errorResult('thought_id is required for chain action')
        const chain = getChainService(args.thought_id, args.direction)
        if (!chain) return errorResult(`Thought '${args.thought_id}' not found`)
        return jsonResult(chain)
      }

      if (action === 'clusters') {
        const results = await searchThoughts({
          query: args.query, topK: args.top_k, clusterFilter: 'only', projectFilter
        })
        return jsonResult(results)
      }

      return errorResult(`Unknown action: ${action}`)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'memory_recall failed')
    }
  })
}
