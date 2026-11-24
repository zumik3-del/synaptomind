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
    description: `Search and retrieve thoughts. One envelope per action: collections answer { items, meta }, single objects { item, meta }, with meta = { action, scope, counts: { total, returned, filtered_out }, degraded, warnings } and an optional reason (no_match, ambiguous_id, id_not_found). Id lookup runs before both search legs: a full UUID is an explicit reference and ignores status/cwd/tag/min_importance, while a hex prefix of 13+ characters is only a timestamp window, so it takes the status/cwd/tag/min_importance scope of the call like any other query, falling back to the ordinary search when it addresses nothing inside it. An id hit never widens to other rows and is never suppressed — standing, superseded_by and contradicted_by stay annotated, and low_confidence keeps its retrieval meaning (no BM25 anchor, cosine below the floor). A prefix that addresses several rows answers every one of them, at most limit, with reason ambiguous_id; a prefix addressing none is not an answer, so the same text is searched and the reply carries an id_not_found warning (reason id_not_found when that found nothing either), keeping hex-looking words searchable. is_cluster is a shape constraint, not a scope, so clusters never answers a non-cluster row. Actions: search (hybrid RRF by default, vector-only with hybrid=false; may mutate via primer promotion/hit count), get, context, chain, clusters (reads cluster thoughts; memory_crystallize creates them), list (inventory without query: status/cwd/tag/is_cluster, limit/offset with the total in meta.counts, never in a row — the same reader memory_reflect action=timeline exposes). Status defaults: search/clusters active, list all. cwd is optional for search, clusters, list and context: it scopes to one project, and omitted it answers across every project with a meta.warnings note; get/chain accept and ignore it, since an id-addressed read keeps its own project. Output: compact (default) gives id, content, status, tags, project; compact=false or fields widen it. context answers chain's view ({ thought, upstream, downstream }) from a query or a thought_id.`,
    inputSchema: {
      action: z.enum(['search', 'get', 'context', 'chain', 'clusters', 'list']).describe('Action'),
      ...RECALL_ARGS
    },
    handlers
  })
}
