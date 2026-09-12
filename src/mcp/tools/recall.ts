import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type ContradictionMode,
  searchThoughts,
  searchThoughtsGrouped,
  type SupersessionMode
} from '../../services/search.service'
import { postProcessSearchResults } from '../../services/search_postprocess.service'
import { getChainService, getContextService } from '../../services/graph.service'
import { getThoughtById } from '../../services/thoughts.service'
import { resolveProjectId } from './utils'
import { registerActionTool, requiredString, type ActionArgs } from './action-tool'

const handlers = {
  get: {
    input: z.object({ thought_id: requiredString('thought_id is required for get action') }),
    run(args: ActionArgs) {
      const thought = getThoughtById(args.thought_id as string)
      if (!thought) throw new Error(`Thought '${args.thought_id}' not found`)
      return thought
    }
  },

  search: {
    input: z.object({ query: requiredString('query is required for search action') }),
    async run(args: ActionArgs) {
      const topK = (args.top_k as number) ?? 10
      const projectFilter = resolveProjectId(args.project_id as string, args.cwd as string)
      const statusFilter = (args.status as string) || 'active'
      // Agent-facing defaults: drop superseded rows, flag contradicted ones.
      const supersessionMode = (args.supersession_mode as SupersessionMode | undefined) ?? 'suppress'
      const contradictionMode = (args.contradiction_mode as ContradictionMode | undefined) ?? 'flag'
      const baseOptions = {
        query: args.query as string, topK, statusFilter,
        projectFilter, tagFilter: args.tag as string | undefined, clusterFilter: args.cluster as 'only' | 'exclude' | undefined,
        minImportance: args.min_importance as number | undefined, excludeFlagged: args.exclude_flagged as boolean | undefined,
        hybrid: args.hybrid as boolean | undefined, supersessionMode, contradictionMode
      }
      const results = args.group_by_cluster
        ? await searchThoughtsGrouped(baseOptions)
        : await searchThoughts(baseOptions)
      return postProcessSearchResults(results, { query: args.query as string, topK, showPrimers: true })
    }
  },

  context: {
    input: z.object({ query: requiredString('query is required for context action') }),
    run(args: ActionArgs) {
      const projectFilter = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
      const context = getContextService(args.query as string, args.max_degree as number | undefined, projectFilter)
      if (!context) throw new Error(`No thoughts matching '${args.query}'`)
      return context
    }
  },

  chain: {
    input: z.object({ thought_id: requiredString('thought_id is required for chain action') }),
    run(args: ActionArgs) {
      const chain = getChainService(args.thought_id as string, args.direction as 'upstream' | 'downstream' | 'both' | undefined, args.max_degree as number | undefined)
      if (!chain) throw new Error(`Thought '${args.thought_id}' not found`)
      return chain
    }
  },

  clusters: {
    input: z.object({ query: requiredString('query is required for clusters action') }),
    async run(args: ActionArgs) {
      const topK = (args.top_k as number) ?? 10
      const projectFilter = resolveProjectId(args.project_id as string, args.cwd as string)
      const statusFilter = (args.status as string) || 'active'
      const results = await searchThoughts({
        query: args.query as string, topK, statusFilter,
        projectFilter, tagFilter: args.tag as string | undefined, clusterFilter: 'only',
        minImportance: args.min_importance as number | undefined, excludeFlagged: args.exclude_flagged as boolean | undefined,
        hybrid: args.hybrid as boolean | undefined
      })
      return postProcessSearchResults(results, { query: args.query as string, topK, showPrimers: true })
    }
  }
}

export function registerMemoryRecall(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_recall',
    description: `Search and retrieve thoughts. Actions:
- search: Hybrid/vector/BM25 search across thoughts (note: may mutate state via primer promotion and hit counting)
- get: Get a single thought by ID
- context: Find best matching thought and return its chain context
- chain: Traverse linked thoughts from a starting point
- clusters: Search clusters by semantic similarity`,
    inputSchema: {
      action: z.enum(['search', 'get', 'context', 'chain', 'clusters']).describe('Action'),
      query: z.string().optional().describe('Search query (required for search/context/clusters, not for chain)'),
      top_k: z.number().int().min(1).max(100).optional().describe('Max results (default 10, 1-100)'),
      status: z.string().optional().describe('Filter by status (default: active)'),
      project_id: z.string().optional().describe('Filter by project (prefer cwd instead)'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project. Always pass this.'),
      tag: z.string().optional().describe('Filter by tag'),
      cluster: z.enum(['only', 'exclude']).optional().describe('Cluster filter: only (clusters only), exclude (exclude clusters)'),
      group_by_cluster: z.boolean().optional().describe('Group results by cluster'),
      min_importance: z.number().min(0).max(1).optional().describe('Minimum importance (0-1)'),
      exclude_flagged: z.boolean().optional().describe('Exclude flagged thoughts'),
      hybrid: z.boolean().optional().describe('Use hybrid search'),
      supersession_mode: z
        .enum(['off', 'flag', 'suppress'])
        .optional()
        .describe('Superseded thoughts: off (no annotation), flag (annotate), suppress (drop). Agent default: suppress'),
      contradiction_mode: z
        .enum(['off', 'flag'])
        .optional()
        .describe('Contradicted thoughts: off or flag (default). Contradicted endpoints are never suppressed'),
      thought_id: z.string().optional().describe('REQUIRED ONLY for "chain" and "get". IGNORED for "search", "context", "clusters".'),
      direction: z.enum(['upstream', 'downstream', 'both']).optional().describe('Traversal direction (default: both)'),
      max_degree: z.number().int().min(1).max(200).optional().describe('Max edges to return for chain/context (default 50, 1-200)')
    },
    handlers
  })
}
