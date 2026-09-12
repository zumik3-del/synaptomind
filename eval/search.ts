// Injectable search path.
//
// The default (deterministic) mode talks straight to the DB search layer and
// supplies its own query embedding, so it never imports the embedder client and
// never spawns the child process. `--real` uses the production service, which
// generates query embeddings via the real embedder.

import type { Database } from 'bun:sqlite'
import { config } from '../src/config'
import { searchThoughts as dbSearchThoughts, type SearchResult } from '../src/db/search'
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
  db: Database,
  dimensions = config.embedder.dimensions
): Searcher {
  return (query, topK, projectFilter) =>
    dbSearchThoughts(db, {
      embedding: deterministicEmbedding(query, dimensions),
      query,
      topK,
      projectFilter,
      hybrid: true
    })
}

export async function realEmbedder(): Promise<EmbedFn> {
  const { generateEmbeddings } = await import('../src/embedder/client')
  return async text => (await generateEmbeddings([text]))[0]
}

export async function realSearcher(): Promise<Searcher> {
  const { searchThoughts } = await import('../src/services/search.service')
  return (query, topK, projectFilter) =>
    searchThoughts({ query, topK, projectFilter } satisfies SearchServiceOptions)
}
