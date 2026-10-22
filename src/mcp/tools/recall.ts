import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { NotFoundError, ValidationError } from '../../errors'
import { thoughtStatusSchema, timelineLimitSchema } from '../../validation'
import { searchThoughts, searchThoughtsGrouped } from '../../services/search.service'
import {
  buildSearchOptions,
  parseContradictionMode,
  parseSupersessionMode
} from '../../services/search-options'
import { postProcessSearchResults } from '../../services/search_postprocess.service'
import { getChainService, getContextService } from '../../services/graph.service'
import { contextHandler } from './recall/context'
import { getThoughtByIdService, listThoughtsPageService } from '../../services/thoughts.service'
import { getHandler as getRecallGetHandler } from './recall/get'
import { resolveProjectId } from './utils'
import { registerActionTool, requiredString, type ActionArgs } from './action-tool'

/**
 * Map the boolean `is_cluster` filter onto the tri-state `cluster` filter. Both
 * express the same thing, so a contradictory pair is a caller error instead of
 * a silent precedence rule.
 */
function resolveClusterFilter(args: ActionArgs): 'only' | 'exclude' | undefined {
  const explicit = args.cluster as 'only' | 'exclude' | undefined
  if (args.is_cluster === undefined) return explicit
  const fromFlag: 'only' | 'exclude' = args.is_cluster ? 'only' : 'exclude'
  if (explicit && explicit !== fromFlag) {
    throw new ValidationError(`cluster='${explicit}' conflicts with is_cluster=${args.is_cluster}; pass one filter`)
  }
  return explicit ?? fromFlag
}

const handlers = {
  get: getRecallGetHandler,

  search: {
    input: z.object({
      query: requiredString('query is required for search action')
    }),
    async run(args: ActionArgs) {
      const topK = (args.top_k as number) ?? 10
      const projectFilter = resolveProjectId(args.project_id as string, args.cwd as string)
      const baseOptions = buildSearchOptions({
        query: args.query as string, topK, status: args.status as string | undefined,
        projectFilter, tagFilter: args.tag as string | undefined, clusterFilter: resolveClusterFilter(args),
        minImportance: args.min_importance as number | undefined,
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

  context: contextHandler,

  chain: {
    input: z.object({ thought_id: requiredString('thought_id is required for chain action') }),
    run(args: ActionArgs) {
      const chain = getChainService(args.thought_id as string, args.direction as 'upstream' | 'downstream' | 'both' | undefined, args.max_degree as number | undefined)
      if (!chain) throw new NotFoundError(`Thought '${args.thought_id}' not found`)
      return chain
    }
  },

  clusters: {
    input: z.object({
      query: requiredString('query is required for clusters action')
    }),
    async run(args: ActionArgs) {
      const topK = (args.top_k as number) ?? 10
      const projectFilter = resolveProjectId(args.project_id as string, args.cwd as string)
      // This action lists cluster thoughts by definition, so an explicit
      // `is_cluster=false` contradicts it.
      if (args.is_cluster === false) {
        throw new ValidationError('the clusters action lists cluster thoughts; is_cluster=false conflicts')
      }
      const results = await searchThoughts(buildSearchOptions({
        query: args.query as string, topK, status: args.status as string | undefined,
        projectFilter, tagFilter: args.tag as string | undefined, clusterFilter: 'only',
        minImportance: args.min_importance as number | undefined,
        hybrid: args.hybrid as boolean | undefined,
        recencyWeight: args.recency_weight as number | undefined,
        recencyHalfLifeDays: args.recency_half_life_days as number | undefined,
        minRelevance: args.min_relevance as number | undefined
      }))
      return postProcessSearchResults(results, { query: args.query as string, topK, showPrimers: true })
    }
  },

  list: {
    // No required argument: an unfiltered inventory is a valid request.
    run(args: ActionArgs) {
      const projectFilter = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
      return listThoughtsPageService({
        status: args.status as string | undefined,
        project_id: projectFilter,
        tag: args.tag as string | undefined,
        is_cluster: args.is_cluster as boolean | undefined,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined
      })
    }
  }
}

export function registerMemoryRecall(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_recall',
    description: `Search and retrieve thoughts. Actions: search (hybrid/vector/BM25; may mutate via primer promotion/hit count), get, context, chain, clusters, list (paginated inventory without query: status/project_id/tag/is_cluster filters, limit/offset paging, total count).`,
    inputSchema: {
      action: z.enum(['search', 'get', 'context', 'chain', 'clusters', 'list']).describe('Action'),
      query: z.string().optional().describe('Search query (required for search/clusters; for context either query or thought_id)'),      top_k: z.coerce.number().int().min(1).max(100).optional().describe('Max results (default 10, 1-100)'),
      status: thoughtStatusSchema.optional().describe('Filter by status (search default: active; list default: all)'),
      project_id: z.string().optional().describe('Filter by project (prefer cwd instead)'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project. Always pass this.'),
      tag: z.string().optional().describe('Filter by tag'),
      cluster: z.enum(['only', 'exclude']).optional().describe('Cluster filter: only (clusters only), exclude (exclude clusters)'),
      is_cluster: z.boolean().optional().describe('Cluster filter: true = cluster thoughts only, false = exclude cluster thoughts (search/list). Conflicts with a contradictory `cluster` value'),
      group_by_cluster: z.boolean().optional().describe('Group results by cluster'),
      min_importance: z.coerce.number().min(0).max(1).optional().describe('Minimum importance (0-1)'),
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
      thought_id: z.string().optional().describe('REQUIRED for "get" and "chain"; also accepted by "context" (alternative to query). IGNORED for "search", "clusters", "list".'),
      include_edges: z.boolean().optional().describe('get only: when true, return incident edges inline (upstream/downstream with type and created_at). Default false.'),
      direction: z.enum(['upstream', 'downstream', 'both']).optional().describe('Traversal direction (default: both)'),
      max_degree: z.coerce.number().int().min(1).max(200).optional().describe('Max edges to return for chain/context (default 50, 1-200)'),
      // The list page shares the timeline's page size (src/validation.ts) so the
      // two paginated thought surfaces cannot drift apart.
      limit: timelineLimitSchema.optional().describe('list: max thoughts (default 50, 1-500)'),
      offset: z.number().int().min(0).max(1_000_000).optional().describe('list: offset for pagination')
    },
    handlers
  })
}
