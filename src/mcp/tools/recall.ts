import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { NotFoundError, ValidationError } from '../../errors'
import { thoughtStatusSchema, timelineLimitSchema } from '../../validation'
import {
  groupResultsByCluster,
  searchThoughtsOutcome
} from '../../services/search.service'
import {
  buildSearchOptions,
  parseContradictionMode,
  parseSupersessionMode
} from '../../services/search-options'
import { postProcessSearchResults } from '../../services/search_postprocess.service'
import { getChainService } from '../../services/graph.service'
import { contextHandler } from './recall/context'
import type { SearchOutcome } from '../../services/search-outcome'
import type { SearchResult } from '../../services/search.service'
import type { GroupedResult } from '../../services/search.service'
import type { Thought } from '../../services/thoughts.service'
import type { EdgeView } from '../../services/edges.service'
import { listThoughtsPageService } from '../../services/thoughts.service'
import { getHandler as getRecallGetHandler } from './recall/get'
import { shapeThought } from './utils'
import { shapeSearchItem } from './recall/shape'
import {
  collectionEnvelope,
  itemEnvelope,
  requireEnvelopeScope,
  type EnvelopeReason
} from './envelope'
import { registerActionTool, requiredString, type ActionArgs } from './action-tool'

const ACTION_FIELDS: Record<string, string[]> = {
  search: ['query', 'status', 'cwd', 'tag', 'is_cluster', 'group_by_cluster', 'min_importance', 'hybrid', 'recency_weight', 'recency_half_life_days', 'min_relevance', 'supersession_mode', 'contradiction_mode', 'limit', 'compact', 'fields'],
  clusters: ['query', 'status', 'cwd', 'tag', 'is_cluster', 'min_importance', 'hybrid', 'recency_weight', 'recency_half_life_days', 'min_relevance', 'limit', 'compact', 'fields'],
  context: ['query', 'thought_id', 'cwd', 'direction', 'max_degree', 'compact', 'fields'],
  chain: ['thought_id', 'direction', 'max_degree', 'compact', 'fields'],
  get: ['thought_id', 'include_edges', 'max_degree', 'compact', 'fields'],
  list: ['status', 'cwd', 'tag', 'is_cluster', 'limit', 'offset', 'compact', 'fields']
}
const ACTION_FIELDS_ALL = new Set(Object.values(ACTION_FIELDS).flat())

function validateActionFields(action: string, args: ActionArgs): void {
  const allowed = new Set(ACTION_FIELDS[action] ?? [])
  const irrelevant = Object.keys(args).filter(key => ACTION_FIELDS_ALL.has(key) && !allowed.has(key))
  if (irrelevant.length) throw new Error(`${irrelevant.join(', ')} is not applicable to ${action} action`)
}

/**
 * The array-returning search service hangs the collection-level `degraded`
 * flag on the returned array (so an empty result set still reports a downed
 * semantic leg); read it back off the outcome's items.
 */
function degradedOf(items: SearchResult[]): boolean {
  return (items as SearchResult[] & { degraded?: boolean }).degraded === true
}

/**
 * Why a search answered with nothing (or with several id matches). `no_match`
 * is only reported when nothing was even considered — a gated result set keeps
 * no reason and shows up as `counts.filtered_out > 0` instead.
 */
function searchReason(outcome: SearchOutcome): EnvelopeReason | undefined {
  if (outcome.reason !== undefined) return outcome.reason
  if (outcome.ambiguous === true) return 'ambiguous_id'
  if (outcome.matched === 0) return 'no_match'
  return undefined
}

const handlers = {
  get: getRecallGetHandler,

  search: {
    input: z.object({
      query: requiredString('query is required for search action'),
      status: thoughtStatusSchema.default('active')
    }),
    async run(args: ActionArgs) {
      const limit = (args.limit as number) ?? 10
      const { scope, warnings, projectId } = requireEnvelopeScope(args.cwd, 'memory_recall', 'search')
      const baseOptions = buildSearchOptions({
        query: args.query as string, topK: limit, status: args.status as string | undefined,
        projectFilter: projectId, tagFilter: args.tag as string | undefined,
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
      const outcome = await searchThoughtsOutcome(baseOptions)
      const degraded = degradedOf(outcome.items)
      const results = args.group_by_cluster
        ? groupResultsByCluster(outcome.items)
        : outcome.items
      const processed = postProcessSearchResults(results, { query: args.query as string, topK: limit, showPrimers: true })
      const compact = args.compact !== false
      const fields = args.fields
      const items = (Array.isArray(processed) ? processed : []).map((r: SearchResult | GroupedResult) => shapeSearchItem(r, compact, fields))
      return collectionEnvelope('search', items, {
        scope,
        warnings: [...warnings, ...(outcome.warnings ?? [])],
        degraded,
        total: outcome.matched,
        filtered_out: outcome.filtered_out,
        reason: searchReason(outcome)
      })
    }
  },

  context: contextHandler,

  chain: {
    input: z.object({ thought_id: requiredString('thought_id is required for chain action') }),
    run(args: ActionArgs) {
      const chain = getChainService(args.thought_id as string, args.direction as 'upstream' | 'downstream' | 'both' | undefined, args.max_degree as number | undefined)
      if (!chain) throw new NotFoundError(`Thought '${args.thought_id}' not found`)
      const compact = args.compact !== false
      const fields = args.fields
      const item = {
        thought: shapeThought(chain.thought, compact, fields),
        upstream: Array.isArray(chain.upstream) ? chain.upstream.map((e: { edge: EdgeView; thought?: Thought }) => ({ ...e, thought: e?.thought ? shapeThought(e.thought, compact, fields) : e?.thought })) : chain.upstream,
        downstream: Array.isArray(chain.downstream) ? chain.downstream.map((e: { edge: EdgeView; thought?: Thought }) => ({ ...e, thought: e?.thought ? shapeThought(e.thought, compact, fields) : e?.thought })) : chain.downstream,
      }
      return itemEnvelope('chain', item)
    }
  },

  clusters: {
    input: z.object({
      query: requiredString('query is required for clusters action'),
      status: thoughtStatusSchema.default('active')
    }),
    async run(args: ActionArgs) {
      const limit = (args.limit as number) ?? 10
      const { scope, warnings, projectId } = requireEnvelopeScope(args.cwd, 'memory_recall', 'clusters')
      // This action lists cluster thoughts by definition, so an explicit
      // `is_cluster=false` contradicts it.
      if (args.is_cluster === false) {
        throw new ValidationError('the clusters action lists cluster thoughts; is_cluster=false conflicts')
      }
      const outcome = await searchThoughtsOutcome(buildSearchOptions({
        query: args.query as string, topK: limit, status: args.status as string | undefined,
        projectFilter: projectId, tagFilter: args.tag as string | undefined, clusterFilter: 'only',
        minImportance: args.min_importance as number | undefined,
        hybrid: args.hybrid as boolean | undefined,
        recencyWeight: args.recency_weight as number | undefined,
        recencyHalfLifeDays: args.recency_half_life_days as number | undefined,
        minRelevance: args.min_relevance as number | undefined
      }))
      const degraded = degradedOf(outcome.items)
      const processed = postProcessSearchResults(outcome.items, { query: args.query as string, topK: limit, showPrimers: true })
      const compact = args.compact !== false
      const fields = args.fields
      const items = (Array.isArray(processed) ? processed : []).map((r: SearchResult | GroupedResult) => shapeSearchItem(r, compact, fields))
      return collectionEnvelope('clusters', items, {
        scope,
        warnings: [...warnings, ...(outcome.warnings ?? [])],
        degraded,
        total: outcome.matched,
        filtered_out: outcome.filtered_out,
        reason: searchReason(outcome)
      })
    }
  },

  list: {
    // No required argument: an unfiltered inventory is a valid request.
    input: z.object({
      status: z.enum(['draft', 'active', 'archived', 'all']).default('all')
    }),
    run(args: ActionArgs) {
      const { scope, warnings, projectId } = requireEnvelopeScope(args.cwd, 'memory_recall', 'list')
      const page = listThoughtsPageService({
        status: args.status as string | undefined,
        project_id: projectId,
        tag: args.tag as string | undefined,
        is_cluster: args.is_cluster as boolean | undefined,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined
      })
      const compact = args.compact !== false
      const fields = args.fields
      const items = page.thoughts.map((t: Thought) => shapeThought(t, compact, fields))
      return collectionEnvelope('list', items, {
        scope,
        warnings,
        total: page.total,
        filtered_out: Math.max(0, page.total - items.length),
        // The page service resolves the defaults (THOUGHTS_PAGE_LIMIT_DEFAULT and
        // offset 0), so the paging metadata reports the values actually applied —
        // same shape as memory_reflect action=timeline (reflect.ts:44).
        counts: { limit: page.limit ?? 0, offset: page.offset }
      })
    }
  }
}

export function registerMemoryRecall(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_recall',
    description: `Search and retrieve thoughts. Every action answers in one envelope: collections return { items, meta }, single objects return { item, meta }. meta = { action, scope, counts: { total, returned, filtered_out }, degraded, warnings } plus an optional reason (no_match, ambiguous_id, id_not_found). Id lookup: a query that is a full UUID or a hex prefix of at least 13 characters is resolved against thought ids before the semantic and lexical legs. A full UUID is an explicit reference and ignores status/cwd/tag/min_importance; a prefix is only a timestamp window, so it takes the status/cwd scope of the call like any other query, and a prefix that addresses nothing inside that scope falls back to the ordinary search. is_cluster is a shape constraint rather than a scope, so it applies to both forms: clusters never answers a non-cluster row (the request comes back empty with a reason). An addressed id never widens to other rows (a prefix that addresses several answers every one of them, at most limit rows, with reason ambiguous_id). The resolution never suppresses a contested hit: standing, superseded_by and contradicted_by are annotated, while low_confidence keeps its retrieval meaning (no BM25 anchor, cosine below the floor) and stays false on an id hit. A miss is not an answer: when an id-shaped query addresses no thought, the answer is the ordinary search for the same text with an id_not_found note in meta.warnings (reason id_not_found only when that fallback matched nothing either), so a hex-looking word stays searchable. Actions: search (hybrid RRF by default; vector-only with hybrid=false; may mutate via primer promotion/hit count), get, context, chain, clusters, list (paginated inventory without query: status/cwd/tag/is_cluster filters; limit/offset and the total ride in meta.counts, never in a row). Status defaults: search/clusters active, list all; pass status to override. cwd is REQUIRED for search, clusters and list (it scopes the answer to one project); it is optional for context and not used by get/chain. Relevance: an omitted min_relevance applies the default gate to cosine-only search/clusters hits (they surface as meta.counts.filtered_out, never as a reason), while BM25-anchored and id rows are never gated. context is exempt from that default gate — it asks for the single best match, so it keeps the pre-gate best match unless a caller passes min_relevance, which is a service-level opt-in there (the tool argument applies to search/clusters). Output modes: compact (default true) keeps the minimal thought fields (id, content, status, tags as strings, project) and no per-hit score block, but never hides a safety annotation — standing is emitted unless it is 'current', and superseded_by/contradicted_by plus low_confidence: true are emitted whenever they apply, so a contested or weak hit never looks clean; ranking metadata, match_source included (['id'] marks an id-addressed hit), is opt-in. compact=false adds that metadata (scores { similarity, distance, rrf_score, bm25_score, relevance, recency_score, final_score }, match_source, plus standing: 'current' and low_confidence: false as neutral markers). An explicit fields selection returns only those thought columns and drops the ranking metadata — scores and match_source, so an id hit is no longer labelled as one; safety annotations and get's include_edges output are not thought columns and stay.`,
    inputSchema: {
      action: z.enum(['search', 'get', 'context', 'chain', 'clusters', 'list']).describe('Action'),
      query: z.string().optional().describe('Search query (REQUIRED for search/clusters; accepted by context as an alternative to thought_id). IGNORED for get/chain/list.'),
      status: thoughtStatusSchema.optional().describe('Filter by status (search/clusters default: active; list default: all). IGNORED for get/context/chain.'),
      project_id: z.never({ error: 'project_id was removed; use cwd' }).optional().describe('Removed; use cwd.'),
      cwd: z.string().optional().describe('Working directory — resolves the project scope reported in meta.scope. REQUIRED for search/clusters/list (a call without it is rejected); OPTIONAL for context; IGNORED for get/chain.'),
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
          'Relevance gate on the calibrated relevance scale (0-1). Omitted = the measured default 0.4 (a raw cosine of 0.84): cosine-only hits below the threshold are dropped, while BM25-anchored and explicit-id rows are never gated. An explicit 0 disables the gate and restores the fail-open result set. Dropped rows appear as meta.counts.filtered_out, not as a reason (search/clusters only; memory_recall action=context is exempt from the default gate and keeps its pre-gate best match, so a gate there is a service-level opt-in).'
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
      compact: z.boolean().optional().describe('Compact output (default true): each hit keeps the minimal thought fields (id, content, status, tags as strings, project) and no score block, but safety annotations are never hidden — standing is emitted unless it is "current", and superseded_by/contradicted_by plus low_confidence: true whenever they apply. compact=false adds the opt-in ranking metadata: scores { similarity, distance, rrf_score, bm25_score, relevance, recency_score, final_score }, match_source, and the neutral standing: "current"/low_confidence: false values. Also shapes the thought objects of get/context/chain/list; get\'s include_edges output stays under both settings.'),
      fields: z.array(z.string()).optional().describe('Thought columns to include in each output thought. Selects on the shaped thought only, so the ranking metadata (scores, match_source — which also drops the [\'id\'] label of an id-addressed hit) is dropped from search hits when set; safety annotations (standing, superseded_by, contradicted_by, low_confidence) and get\'s include_edges output are not thought columns and remain. OPTIONAL for all actions.'),
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
