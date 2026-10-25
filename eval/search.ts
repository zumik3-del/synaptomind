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
 * The harness measures ranking quality (recall/precision against labeled
 * results), not the agent-facing noise gate: the measured default gate
 * (`DEFAULT_MIN_RELEVANCE`) would drop deterministic-mode vector rows wholesale,
 * because the feature-hashing embeddings sit far below the real cosine band. The
 * recorded `eval/thresholds.json` baselines were produced without a gate, so the
 * harness pins `minRelevance: 0` to stay comparable (task #2178).
 */
const HARNESS_MIN_RELEVANCE = 0

export function deterministicEmbedder(dimensions = config.embedder.dimensions): EmbedFn {
  return text => deterministicEmbedding(text, dimensions)
}

export function createDeterministicSearcher(
  dimensions = config.embedder.dimensions
): Searcher {
  return async (query, topK, projectFilter, options) => {
    const { searchThoughts } = await import('../src/services/search.service')
    return searchThoughts({
      query,
      topK,
      projectFilter,
      embedding: deterministicEmbedding(query, dimensions),
      supersessionMode: 'suppress',
      contradictionMode: 'flag',
      minRelevance: HARNESS_MIN_RELEVANCE,
      recencyWeight: options?.recencyWeight,
      recencyHalfLifeDays: options?.recencyHalfLifeDays
    } satisfies SearchServiceOptions)
  }
}

export async function realEmbedder(): Promise<EmbedFn> {
  const { generateEmbeddings } = await import('../src/embedder/client')
  return async text => (await generateEmbeddings([text]))[0]
}

export async function realSearcher(): Promise<Searcher> {
  const { searchThoughts } = await import('../src/services/search.service')
  return (query, topK, projectFilter, options) =>
    searchThoughts({
      query,
      topK,
      projectFilter,
      supersessionMode: 'suppress',
      contradictionMode: 'flag',
      minRelevance: HARNESS_MIN_RELEVANCE,
      recencyWeight: options?.recencyWeight,
      recencyHalfLifeDays: options?.recencyHalfLifeDays
    } satisfies SearchServiceOptions)
}
