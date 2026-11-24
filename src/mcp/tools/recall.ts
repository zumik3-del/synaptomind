import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import { ValidationError } from '../../errors'
import { thoughtStatusSchema } from '../../validation'
import { groupResultsByCluster, searchThoughtsOutcome } from '../../services/search.service'
import {
  buildSearchOptions,
  parseContradictionMode,
  parseSupersessionMode
} from '../../services/search-options.service'
import { postProcessSearchResults } from '../../services/search_postprocess.service'
import { contextHandler } from './recall/context'
import { RECALL_ARGS } from './recall/args'
import type { SearchOutcome } from '../../services/search-outcome.service'
import type { SearchResult } from '../../services/search.service'
import type { GroupedResult } from '../../services/search.service'
import { getHandler as getRecallGetHandler } from './recall/get'
import { chainOptions, chainView } from './recall/chain'
import { loadUrlLinks, type BatchUrlLinks } from './utils'
import { shapeSearchItem } from './recall/shape'
import { listPage } from './list-page'
import {
  collectionEnvelope,
  itemEnvelope,
  readEnvelopeScope,
  type EnvelopeReason
} from './envelope'
import {
  ADDS_ONLY,
  actionInput,
  registerActionTool,
  requiredString,
  type ActionArgs
} from './action-tool'

const SEARCH_ARGS = [
  'query',
  'status',
  'cwd',
  'tag',
  'is_cluster',
  'group_by_cluster',
  'min_importance',
  'hybrid',
  'recency_weight',
  'recency_half_life_days',
  'min_relevance',
  'supersession_mode',
  'contradiction_mode',
  'limit',
  'compact',
  'fields',
  'include_url_links'
]

function degradedOf(items: SearchResult[]): boolean {
  return (items as SearchResult[] & { degraded?: boolean }).degraded === true
}

function searchReason(outcome: SearchOutcome): EnvelopeReason | undefined {
  if (outcome.reason !== undefined) return outcome.reason
  if (outcome.ambiguous === true) return 'ambiguous_id'
  if (outcome.matched === 0) return 'no_match'
  return undefined
}

function searchUrlLinks(
  items: Array<SearchResult | GroupedResult>,
  requested: unknown
): BatchUrlLinks | undefined {
  if (requested !== true) return undefined
  const thoughts = items.flatMap(r =>
    'cluster' in r ? (r.items ?? []).map(i => i.thought) : [r.thought]
  )
  return loadUrlLinks(thoughts)
}

function finalizeSearchAction(
  action: 'search' | 'clusters',
  outcome: SearchOutcome,
  args: ActionArgs,
  scope: ReturnType<typeof readEnvelopeScope>['scope'],
  warnings: string[],
  groupByCluster: boolean
) {
  const degraded = degradedOf(outcome.items)
  const results = groupByCluster ? groupResultsByCluster(outcome.items) : outcome.items
  const processed = postProcessSearchResults(results, { showPrimers: true })
  const compact = args.compact !== false
  const fields = args.fields
  const hits = Array.isArray(processed) ? processed : []
  const urlLinks = searchUrlLinks(hits, args.include_url_links)
  const items = hits.map((r: SearchResult | GroupedResult) =>
    shapeSearchItem(r, compact, fields, urlLinks)
  )
  return collectionEnvelope(action, items, {
    scope,
    warnings: [...warnings, ...(outcome.warnings ?? [])],
    degraded,
    total: outcome.matched,
    filtered_out: outcome.filtered_out,
    reason: searchReason(outcome)
  })
}

function queryActionPreamble(args: ActionArgs) {
  const limit = (args.limit as number) ?? 10
  const { scope, warnings, projectId } = readEnvelopeScope(args.cwd)
  return { limit, scope, warnings, projectId }
}

const handlers = {
  get: getRecallGetHandler,

  search: {
    input: actionInput(RECALL_ARGS, SEARCH_ARGS, {
      query: requiredString('query is required for search action'),
      status: thoughtStatusSchema.default('active')
    }),
    async run(args: ActionArgs) {
      const { limit, scope, warnings, projectId } = queryActionPreamble(args)
      const baseOptions = buildSearchOptions({
        query: args.query as string,
        topK: limit,
        status: args.status as string | undefined,
        projectFilter: projectId,
        tagFilter: args.tag as string | undefined,
        clusterFilter:
          args.is_cluster === undefined ? undefined : args.is_cluster ? 'only' : 'exclude',
        minImportance: args.min_importance as number | undefined,
        hybrid: args.hybrid as boolean | undefined,
        supersessionMode: parseSupersessionMode(args.supersession_mode as string | undefined),
        contradictionMode: parseContradictionMode(args.contradiction_mode as string | undefined),
        recencyWeight: args.recency_weight as number | undefined,
        recencyHalfLifeDays: args.recency_half_life_days as number | undefined,
        minRelevance: args.min_relevance as number | undefined
      })
      const outcome = await searchThoughtsOutcome(baseOptions)
      return finalizeSearchAction(
        'search',
        outcome,
        args,
        scope,
        warnings,
        args.group_by_cluster === true
      )
    }
  },

  context: contextHandler,

  chain: {
    input: actionInput(
      RECALL_ARGS,
      ['thought_id', 'direction', 'max_degree', 'compact', 'fields', 'include_url_links'],
      { thought_id: requiredString('thought_id is required for chain action') }
    ),
    run(args: ActionArgs) {
      return itemEnvelope('chain', chainView(args.thought_id as string, chainOptions(args)))
    }
  },

  clusters: {
    input: actionInput(
      RECALL_ARGS,
      [
        'query',
        'status',
        'cwd',
        'tag',
        'is_cluster',
        'min_importance',
        'hybrid',
        'recency_weight',
        'recency_half_life_days',
        'min_relevance',
        'limit',
        'compact',
        'fields',
        'include_url_links'
      ],
      {
        query: requiredString('query is required for clusters action'),
        status: thoughtStatusSchema.default('active')
      }
    ),
    async run(args: ActionArgs) {
      const { limit, scope, warnings, projectId } = queryActionPreamble(args)
      if (args.is_cluster === false) {
        throw new ValidationError(
          'the clusters action lists cluster thoughts; is_cluster=false conflicts'
        )
      }
      const outcome = await searchThoughtsOutcome(
        buildSearchOptions({
          query: args.query as string,
          topK: limit,
          status: args.status as string | undefined,
          projectFilter: projectId,
          tagFilter: args.tag as string | undefined,
          clusterFilter: 'only',
          minImportance: args.min_importance as number | undefined,
          hybrid: args.hybrid as boolean | undefined,
          recencyWeight: args.recency_weight as number | undefined,
          recencyHalfLifeDays: args.recency_half_life_days as number | undefined,
          minRelevance: args.min_relevance as number | undefined
        })
      )
      return finalizeSearchAction('clusters', outcome, args, scope, warnings, false)
    }
  },

  list: {
    input: actionInput(
      RECALL_ARGS,
      [
        'status',
        'cwd',
        'tag',
        'is_cluster',
        'limit',
        'offset',
        'compact',
        'fields',
        'include_url_links'
      ],
      { status: z.enum(['draft', 'active', 'archived', 'all']).default('all') }
    ),
    run(args: ActionArgs) {
      return listPage('list', args)
    }
  }
}

export function registerMemoryRecall(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_recall',
    annotations: ADDS_ONLY,
    description: `Search and retrieve thoughts. Every action answers in one envelope: collections return { items, meta }, single objects return { item, meta }. meta = { action, scope, counts: { total, returned, filtered_out }, degraded, warnings } plus an optional reason (no_match, ambiguous_id, id_not_found). Id lookup: a query that is a full UUID or a hex prefix of at least 13 characters is resolved against thought ids before the semantic and lexical legs. A full UUID is an explicit reference and ignores status/cwd/tag/min_importance; a prefix is only a timestamp window, so it takes the status/cwd/tag/min_importance scope of the call like any other query, and a prefix that addresses nothing inside that scope falls back to the ordinary search. is_cluster is a shape constraint rather than a scope, so it applies to both forms: clusters never answers a non-cluster row (the request comes back empty with a reason). An addressed id never widens to other rows (a prefix that addresses several answers every one of them, at most limit rows, with reason ambiguous_id). The resolution never suppresses a contested hit: standing, superseded_by and contradicted_by are annotated, while low_confidence keeps its retrieval meaning (no BM25 anchor, cosine below the floor) and stays false on an id hit. A miss is not an answer: when an id-shaped query addresses no thought, the answer is the ordinary search for the same text with an id_not_found note in meta.warnings (reason id_not_found only when that fallback matched nothing either), so a hex-looking word stays searchable. Actions: search (hybrid RRF by default; vector-only with hybrid=false; may mutate via primer promotion/hit count), get, context, chain, clusters (reads cluster thoughts; creating or regrouping them is memory_crystallize, not this action), list (paginated inventory without query: status/cwd/tag/is_cluster filters; limit/offset and the total ride in meta.counts, never in a row — the same reader memory_reflect action=timeline exposes). Status defaults: search/clusters active, list all; pass status to override. cwd is optional for search, clusters, list and context: it scopes the answer to one project, and omitted, it answers across every project with a meta.warnings note; get/chain accept it and ignore it (an id-addressed read keeps its own project). Output: compact defaults to true (id, content, status, tags, project); compact=false or fields widen it. context answers the same chain view as chain ({ thought, upstream, downstream }), from a text query or a thought_id.`,
    inputSchema: {
      action: z.enum(['search', 'get', 'context', 'chain', 'clusters', 'list']).describe('Action'),
      ...RECALL_ARGS
    },
    handlers
  })
}
