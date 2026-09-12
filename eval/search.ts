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

export type Searcher = (
  query: string,
  topK: number,
  projectFilter?: string
) => Promise<SearchResult[]> | SearchResult[]

export function deterministicEmbedder(dimensions = config.embedder.dimensions): EmbedFn {
  return text => deterministicEmbedding(text, dimensions)
}

export function createDeterministicSearcher(
  dimensions = config.embedder.dimensions
): Searcher {
  return async (query, topK, projectFilter) => {
    const { searchThoughts } = await import('../src/services/search.service')
    return searchThoughts({
      query,
      topK,
      projectFilter,
      embedding: deterministicEmbedding(query, dimensions),
      supersessionMode: 'suppress',
      contradictionMode: 'flag'
    } satisfies SearchServiceOptions)
  }
}

export async function realEmbedder(): Promise<EmbedFn> {
  const { generateEmbeddings } = await import('../src/embedder/client')
  return async text => (await generateEmbeddings([text]))[0]
}

export async function realSearcher(): Promise<Searcher> {
  const { searchThoughts } = await import('../src/services/search.service')
  return (query, topK, projectFilter) =>
    searchThoughts({
      query,
      topK,
      projectFilter,
      supersessionMode: 'suppress',
      contradictionMode: 'flag'
    } satisfies SearchServiceOptions)
}
