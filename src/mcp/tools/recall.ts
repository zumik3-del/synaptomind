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
import { getChainService } from '../../services/graph.service'
import { contextHandler } from './recall/context'
import { listThoughtsPageService } from '../../services/thoughts.service'
import { getHandler as getRecallGetHandler } from './recall/get'
import { resolveProjectId } from './utils'
import { registerActionTool, requiredString, type ActionArgs } from './action-tool'

const ACTION_FIELDS: Record<string, string[]> = {
  search: ['query', 'status', 'project_id', 'cwd', 'tag', 'is_cluster', 'group_by_cluster', 'min_importance', 'hybrid', 'recency_weight', 'recency_half_life_days', 'min_relevance', 'supersession_mode', 'contradiction_mode', 'limit'],
  clusters: ['query', 'status', 'project_id', 'cwd', 'tag', 'is_cluster', 'min_importance', 'hybrid', 'recency_weight', 'recency_half_life_days', 'min_relevance', 'limit'],
  context: ['query', 'thought_id', 'project_id', 'cwd', 'direction', 'max_degree'],
  chain: ['thought_id', 'direction', 'max_degree'],
  get: ['thought_id', 'include_edges', 'max_degree'],
  list: ['status', 'project_id', 'cwd', 'tag', 'is_cluster', 'limit', 'offset']
}
const ACTION_FIELDS_ALL = new Set(Object.values(ACTION_FIELDS).flat())

function validateActionFields(action: string, args: ActionArgs): void {
  const allowed = new Set(ACTION_FIELDS[action] ?? [])
  const irrelevant = Object.keys(args).filter(key => ACTION_FIELDS_ALL.has(key) && !allowed.has(key))
  if (irrelevant.length) throw new Error(`${irrelevant.join(', ')} is not applicable to ${action} action`)
}

const handlers = {
  get: getRecallGetHandler,

  search: {
    input: z.object({
      query: requiredString('query is required for search action')
    }),
    async run(args: ActionArgs) {
      const limit = (args.limit as number) ?? 10
      const projectFilter = resolveProjectId(args.project_id as string, args.cwd as string)
      const baseOptions = buildSearchOptions({
        query: args.query as string, topK: limit, status: args.status as string | undefined,
        projectFilter, tagFilter: args.tag as string | undefined,
        clusterFilter: args.is_cluster === undefined ? undefined : args.is_cluster ? 'only' : 'exclude',
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
      return postProcessSearchResults(results, { query: args.query as string, topK: limit, showPrimers: true })
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
      const limit = (args.limit as number) ?? 10
      const projectFilter = resolveProjectId(args.project_id as string, args.cwd as string)
      // This action lists cluster thoughts by definition, so an explicit
      // `is_cluster=false` contradicts it.
      if (args.is_cluster === false) {
        throw new ValidationError('the clusters action lists cluster thoughts; is_cluster=false conflicts')
      }
      const results = await searchThoughts(buildSearchOptions({
        query: args.query as string, topK: limit, status: args.status as string | undefined,
        projectFilter, tagFilter: args.tag as string | undefined, clusterFilter: 'only',
        minImportance: args.min_importance as number | undefined,
        hybrid: args.hybrid as boolean | undefined,
        recencyWeight: args.recency_weight as number | undefined,
        recencyHalfLifeDays: args.recency_half_life_days as number | undefined,
        minRelevance: args.min_relevance as number | undefined
      }))
      return postProcessSearchResults(results, { query: args.query as string, topK: limit, showPrimers: true })
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
    description: `Search and retrieve thoughts. Actions: search (hybrid RRF by default; vector-only with hybrid=false; may mutate via primer promotion/hit count), get, context, chain, clusters, list (paginated inventory without query: status/project_id/tag/is_cluster filters, limit/offset paging, total count).`,
    inputSchema: {
      action: z.enum(['search', 'get', 'context', 'chain', 'clusters', 'list']).describe('Action'),
      query: z.string().optional().describe('Search query (REQUIRED for search/clusters; accepted by context as an alternative to thought_id). IGNORED for get/chain/list.'),
      status: thoughtStatusSchema.optional().describe('Filter by status (search/clusters default: active; list default: all). IGNORED for get/context/chain.'),
      project_id: z.string().optional().describe('Filter by project (prefer cwd instead). Consumed by search/clusters/context/list. IGNORED for get/chain.'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project (search/clusters/context/list). Always pass this. IGNORED for get/chain.'),
      tag: z.string().optional().describe('Filter by tag (search/clusters/list). IGNORED for get/context/chain.'),
      is_cluster: z.boolean().optional().describe('Cluster filter: true = cluster thoughts only, false = exclude cluster thoughts (search/clusters/list). IGNORED for get/context/chain.'),
      group_by_cluster: z.boolean().optional().describe('Group results by cluster (search only).'),
      min_importance: z.coerce.number().min(0).max(1).optional().describe('Minimum importance (0-1) (search/clusters only).'),
      hybrid: z.boolean().optional().describe('Hybrid search: true (default) fuses the vector and BM25 legs via RRF; false restricts results to the vector (embedding) leg only. (search/clusters only).'),
      mode: z.never({ error: 'mode was removed; use hybrid' }).optional().describe('Removed; use hybrid.'),

      recency_weight: z
        .coerce.number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          'Opt-in recency boost weight (0-1). 0/default preserves relevance-only ranking; >0 adds recency_weight × 0.5^(ageDays/halfLifeDays) to the relevance score and returns recency_score + final_score (search/clusters only).'
        ),
      recency_half_life_days: z
        .coerce.number()
        .positive()
        .max(3650)
        .optional()
        .describe('Recency decay half-life in days (default 30, 1-3650); only used when recency_weight > 0 (search/clusters only).'),
      min_relevance: z
        .coerce.number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          'Opt-in relevance gate (0-1, default 0). >0 drops weak vector-only results: keeps lexical (bm25) hits and vector hits with similarity >= min_relevance. 0 preserves the full result set (search/clusters only).'
        ),
      supersession_mode: z
        .enum(['off', 'flag', 'suppress'])
        .optional()
        .describe('Superseded thoughts: off (no annotation), flag (annotate), suppress (drop). Agent default: suppress (search only).'),
      contradiction_mode: z
        .enum(['off', 'flag'])
        .optional()
        .describe('Contradicted thoughts: off or flag (default). Contradicted endpoints are never suppressed (search only).'),
      thought_id: z.string().optional().describe('REQUIRED for "get" and "chain"; also accepted by "context" (alternative to query). IGNORED for "search", "clusters", "list".'),
      include_edges: z.boolean().optional().describe('get only: when true, return incident edges inline (upstream/downstream with type and created_at). Default false.'),
      direction: z.enum(['upstream', 'downstream', 'both']).optional().describe('Traversal direction (default: both) (context/chain only).'),
      max_degree: z.coerce.number().int().min(1).max(200).optional().describe('Max edges to return for chain/context/get (default 50, 1-200). IGNORED for search/clusters/list.'),
      // The list page shares the timeline's page size (src/validation.ts) so the
      // two paginated thought surfaces cannot drift apart.
      limit: timelineLimitSchema.optional().describe('Max results for search/clusters (default 10) or list page size (default 50). IGNORED for get/context/chain.'),
      offset: z.number().int().min(0).max(1_000_000).optional().describe('list only: offset for pagination. IGNORED for all other actions.'),
      // Tombstones for retired parameters: a supplied value fails the advertised
      // input validation with the canonical replacement (the same pattern as
      // the retired is_profile input) instead of being silently stripped.
      top_k: z.never({ error: 'top_k was removed; use limit' }).optional().describe('Removed; use limit.'),
      cluster: z.never({ error: 'cluster was removed; use is_cluster' }).optional().describe('Removed; use is_cluster.')
    },
    handlers: Object.fromEntries(Object.entries(handlers).map(([action, handler]) => [action, {
      ...handler,
      async run(args: ActionArgs) { validateActionFields(action, args); return handler.run(args) }
    }]))
  })
}
