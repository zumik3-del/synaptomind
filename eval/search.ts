// Injectable search path.
//
// The default (deterministic) mode goes through the production search service
// but injects its own query embedding, so it never calls the embedder client and
// never spawns the child process. `--real` uses the same service with the real
// query embedding. Both run with agent-facing supersession semantics
// (`suppress`), so the harness exercises the standing path.

import { config } from '../src/config'
import type { SearchResult } from '../src/db/search'
import type { SearchServiceOptions } from '../src/services/search.service'
import { deterministicEmbedding } from './embedding'
import type { RelevanceGate } from './types'

export type EmbedFn = (text: string) => Float32Array | Promise<Float32Array>

/** Per-query search knobs forwarded to `SearchServiceOptions`. */
interface QuerySearchOptions {
  recencyWeight?: number
  recencyHalfLifeDays?: number
}

type Searcher = (
  query: string,
  topK: number,
  projectFilter?: string,
  options?: QuerySearchOptions
) => Promise<SearchResult[]> | SearchResult[]

/**
 * Search output for one query: the hits plus the service's own gate
 * bookkeeping, so a pass that enables the gate can say how many rows it dropped
 * (`SearchOutcome.filtered_out`) rather than inferring it from a set difference.
 */
export interface SearcherOutput {
  hits: SearchResult[]
  /** Rows the relevance gate dropped for this query (`0` when the gate is off). */
  filteredOut: number
}

/** Searcher variant that also reports the gate bookkeeping (see `SearcherOutput`). */
export type OutcomeSearcher = (
  query: string,
  topK: number,
  projectFilter?: string,
  options?: QuerySearchOptions
) => Promise<SearcherOutput>

/**
 * The harness measures ranking quality (recall/precision against labeled
 * results). Two passes exist:
 *
 * - the gated pass (task #2191) leaves `minRelevance` unset, so the service
 *   resolves the production default exactly as the MCP/HTTP surface does;
 * - the ungated pass pins `minRelevance: 0`. The recorded `eval/thresholds.json`
 *   baselines were produced without a gate (the deterministic feature-hashing
 *   embeddings sit far below the real cosine band, so the default gate would
 *   drop deterministic-mode vector rows wholesale), so that pass stays
 *   comparable to them.
 */
export const HARNESS_MIN_RELEVANCE = 0

/**
 * The gate threshold production resolves when a caller omits `min_relevance`.
 * Resolved through the service's own normalizer instead of importing the
 * constant, so the harness reports the value production actually applies.
 */
export async function resolveDefaultMinRelevance(): Promise<number> {
  const { normalizeSearchOptions } = await import('../src/services/search-normalize')
  return normalizeSearchOptions({ query: '' }).minRelevance
}

/**
 * `minRelevance` for a pass. `undefined` is the honest "caller did not choose"
 * signal the normalizer turns into `DEFAULT_MIN_RELEVANCE`; `0` disables the
 * gate.
 */
function gateValue(gate: RelevanceGate): number | undefined {
  return gate === 'default' ? undefined : HARNESS_MIN_RELEVANCE
}

function baseOptions(
  query: string,
  topK: number,
  projectFilter: string | undefined,
  options: QuerySearchOptions | undefined,
  gate: RelevanceGate
): Omit<SearchServiceOptions, 'embedding'> {
  return {
    query,
    topK,
    projectFilter,
    supersessionMode: 'suppress',
    contradictionMode: 'flag',
    minRelevance: gateValue(gate),
    recencyWeight: options?.recencyWeight,
    recencyHalfLifeDays: options?.recencyHalfLifeDays
  }
}

async function runSearch(options: SearchServiceOptions): Promise<SearcherOutput> {
  const { searchThoughtsOutcome } = await import('../src/services/search.service')
  const outcome = await searchThoughtsOutcome(options)
  return { hits: outcome.items, filteredOut: outcome.filtered_out }
}

export function deterministicEmbedder(dimensions = config.embedder.dimensions): EmbedFn {
  return text => deterministicEmbedding(text, dimensions)
}

export function createDeterministicOutcomeSearcher(
  dimensions = config.embedder.dimensions,
  gate: RelevanceGate = 'off'
): OutcomeSearcher {
  return async (query, topK, projectFilter, options) =>
    runSearch({
      ...baseOptions(query, topK, projectFilter, options, gate),
      embedding: deterministicEmbedding(query, dimensions)
    } satisfies SearchServiceOptions)
}

export function createDeterministicSearcher(
  dimensions = config.embedder.dimensions
): Searcher {
  const outcomeSearcher = createDeterministicOutcomeSearcher(dimensions, 'off')
  return async (query, topK, projectFilter, options) =>
    (await outcomeSearcher(query, topK, projectFilter, options)).hits
}

export async function realEmbedder(): Promise<EmbedFn> {
  const { generateEmbeddings } = await import('../src/embedder/client')
  return async text => (await generateEmbeddings([text]))[0]
}

export async function realOutcomeSearcher(gate: RelevanceGate = 'off'): Promise<OutcomeSearcher> {
  return (query, topK, projectFilter, options) =>
    runSearch(baseOptions(query, topK, projectFilter, options, gate))
}
