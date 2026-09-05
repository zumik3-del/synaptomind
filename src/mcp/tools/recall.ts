import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { searchThoughts, searchThoughtsGrouped } from '../../services/search.service'
import { postProcessSearchResults } from '../../services/search_postprocess.service'
import { getChainService, getContextService } from '../../services/graph.service'
import { getThoughtById } from '../../services/thoughts.service'
import { jsonResult, errorResult, resolveProjectId } from './utils'

type RecallArgs = Record<string, unknown>

const actionHandlers: Record<string, (args: RecallArgs) => unknown | Promise<unknown>> = {
  get(args) {
    if (!args.thought_id) throw new Error('thought_id is required for get action')
    const thought = getThoughtById(args.thought_id as string)
    if (!thought) throw new Error(`Thought '${args.thought_id}' not found`)
    return thought
  },

  async search(args) {
    const topK = (args.top_k as number) ?? 10
    const projectFilter = resolveProjectId(args.project_id as string, args.cwd as string)
    const results = args.group_by_cluster
      ? await searchThoughtsGrouped({
          query: args.query as string, topK, statusFilter: args.status as string | undefined,
          projectFilter, tagFilter: args.tag as string | undefined, clusterFilter: args.cluster as 'only' | 'exclude' | undefined,
          minImportance: args.min_importance as number | undefined, excludeFlagged: args.exclude_flagged as boolean | undefined,
          hybrid: args.hybrid as boolean | undefined
        })
      : await searchThoughts({
          query: args.query as string, topK, statusFilter: args.status as string | undefined,
          projectFilter, tagFilter: args.tag as string | undefined, clusterFilter: args.cluster as 'only' | 'exclude' | undefined,
          minImportance: args.min_importance as number | undefined, excludeFlagged: args.exclude_flagged as boolean | undefined,
          hybrid: args.hybrid as boolean | undefined
        })
    return postProcessSearchResults(results, { query: args.query as string, topK, showPrimers: true })
  },

  async context(args) {
    const context = getContextService(args.query as string, args.max_degree as number | undefined)
    if (!context) throw new Error(`No thoughts matching '${args.query}'`)
    return context
  },

  chain(args) {
    if (!args.thought_id) throw new Error('thought_id is required for chain action')
    const chain = getChainService(args.thought_id as string, args.direction as 'upstream' | 'downstream' | 'both' | undefined, args.max_degree as number | undefined)
    if (!chain) throw new Error(`Thought '${args.thought_id}' not found`)
    return chain
  },

  async clusters(args) {
    const projectFilter = resolveProjectId(args.project_id as string, args.cwd as string)
    return searchThoughts({
      query: args.query as string, topK: args.top_k as number | undefined, clusterFilter: 'only', projectFilter
    })
  }
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
    thought_id: z.string().optional().describe('REQUIRED ONLY for "chain" and "get". IGNORED for "search", "context", "clusters".'),
    direction: z.enum(['upstream', 'downstream', 'both']).optional().describe('Traversal direction (default: both)'),
    max_degree: z.number().optional().describe('Max edges to return for chain/context (default 50)')
  }, async (args) => {
    const action = (args.action as string) ?? 'search'
    try {
      const handler = actionHandlers[action]
      if (!handler) return errorResult(`Unknown action: ${action}`)
      return jsonResult(await handler(args))
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'memory_recall failed')
    }
  })
}
