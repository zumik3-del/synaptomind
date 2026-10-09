import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { searchThoughts, searchThoughtsGrouped } from '../../services/search.service'
import {
  buildSearchOptions,
  parseContradictionMode,
  parseSupersessionMode
} from '../../services/search-options'
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
      const baseOptions = buildSearchOptions({
        query: args.query as string, topK, status: args.status as string | undefined,
        projectFilter, tagFilter: args.tag as string | undefined, clusterFilter: args.cluster as 'only' | 'exclude' | undefined,
        minImportance: args.min_importance as number | undefined, excludeFlagged: args.exclude_flagged as boolean | undefined,
        includeGlobal: args.include_global as boolean | undefined,
        hybrid: args.hybrid as boolean | undefined,
        // Agent-facing defaults: drop superseded rows, flag contradicted ones.
        supersessionMode: parseSupersessionMode(args.supersession_mode as string | undefined),
        contradictionMode: parseContradictionMode(args.contradiction_mode as string | undefined),
        recencyWeight: args.recency_weight as number | undefined,
        recencyHalfLifeDays: args.recency_half_life_days as number | undefined,
        minRelevance: args.min_relevance as number | undefined
      })
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
      if (!context) throw new Error(`No context found for query '${args.query}'`)
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
      const results = await searchThoughts(buildSearchOptions({
        query: args.query as string, topK, status: args.status as string | undefined,
        projectFilter, tagFilter: args.tag as string | undefined, clusterFilter: 'only',
        minImportance: args.min_importance as number | undefined, excludeFlagged: args.exclude_flagged as boolean | undefined,
        includeGlobal: args.include_global as boolean | undefined,
        hybrid: args.hybrid as boolean | undefined,
        recencyWeight: args.recency_weight as number | undefined,
        recencyHalfLifeDays: args.recency_half_life_days as number | undefined,
        minRelevance: args.min_relevance as number | undefined
      }))
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
      top_k: z.coerce.number().int().min(1).max(100).optional().describe('Max results (default 10, 1-100)'),
      status: z.string().optional().describe('Filter by status (default: active)'),
      project_id: z.string().optional().describe('Filter by project (prefer cwd instead)'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project. Always pass this.'),
      tag: z.string().optional().describe('Filter by tag'),
      cluster: z.enum(['only', 'exclude']).optional().describe('Cluster filter: only (clusters only), exclude (exclude clusters)'),
      group_by_cluster: z.boolean().optional().describe('Group results by cluster'),
      min_importance: z.coerce.number().min(0).max(1).optional().describe('Minimum importance (0-1)'),
      exclude_flagged: z.boolean().optional().describe('Exclude flagged thoughts'),
      include_global: z.boolean().optional().describe('When true and project_id is set, include global thoughts in results'),
      hybrid: z.boolean().optional().describe('Use hybrid search'),
      recency_weight: z
        .coerce.number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          'Opt-in recency boost weight (0-1). 0/default preserves relevance-only ranking; >0 adds recency_weight × 0.5^(ageDays/halfLifeDays) to the relevance score and returns recency_score + final_score'
        ),
      recency_half_life_days: z
        .coerce.number()
        .positive()
        .max(3650)
        .optional()
        .describe('Recency decay half-life in days (default 30, 1-3650); only used when recency_weight > 0'),
      min_relevance: z
        .coerce.number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          'Opt-in relevance gate (0-1, default 0). >0 drops weak vector-only results: keeps lexical (bm25) hits and vector hits with similarity >= min_relevance. 0 preserves the full result set'
        ),
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
      max_degree: z.coerce.number().int().min(1).max(200).optional().describe('Max edges to return for chain/context (default 50, 1-200)')
    },
    handlers
  })
}
