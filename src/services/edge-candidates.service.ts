/**
 * Shared embedding-neighbour pair generator (ADR #142, D3 DRY note).
 *
 * Both `auto-link` (creates `related` edges) and `edge-detect` (proposals only)
 * discover candidate pairs the same way: embed each candidate, look up its
 * vector neighbours, keep the ones above a similarity threshold, and deduplicate
 * by unordered pair. Only this generic step is shared — what each caller does
 * with the pairs stays separate.
 */

import { pairKey } from '../db/utils'

/** A single vector-search hit: neighbour id + similarity in [0, 1]. */
export interface EmbeddingNeighbor {
  id: string
  similarity: number
}

/**
 * Vector neighbour lookup, injected so callers can swap in a deterministic stub
 * in tests or a different index. `thoughtId` is the query thought (used for
 * logging/telemetry by real implementations, may be ignored by stubs).
 */
export type SearchNeighborsFn = (
  thoughtId: string,
  embedding: Float32Array,
  topK: number
) => EmbeddingNeighbor[]

export interface EmbeddingNeighborPair {
  source_id: string
  target_id: string
  embeddingSimilarity: number
}

/**
 * Build deduplicated embedding-proximity pairs from candidate thoughts.
 *
 * `embeddings[i]` must correspond to `candidates[i]`. A neighbour is kept only
 * when it is itself a candidate, is not the query thought, and has similarity
 * >= `minSimilarity` (the recall filter). Pairs are returned once, with the
 * highest observed similarity. Neighbour-search failures are swallowed so a
 * missing/broken vector index degrades to "no pairs" instead of crashing.
 */
export function findEmbeddingNeighborPairs(
  candidates: Array<{ id: string }>,
  embeddings: Float32Array[],
  minSimilarity: number,
  searchNeighbors: SearchNeighborsFn,
  topK = 20
): EmbeddingNeighborPair[] {
  const candidateSet = new Set(candidates.map(c => c.id))
  const pairMap = new Map<string, EmbeddingNeighborPair>()

  for (let i = 0; i < candidates.length; i++) {
    const embedding = embeddings[i]
    if (!embedding) continue

    let results: EmbeddingNeighbor[]
    try {
      results = searchNeighbors(candidates[i].id, embedding, topK)
    } catch {
      continue
    }

    for (const r of results) {
      if (r.id === candidates[i].id) continue
      if (!candidateSet.has(r.id)) continue
      if (r.similarity < minSimilarity) continue

      const key = pairKey(candidates[i].id, r.id)
      const existing = pairMap.get(key)
      if (existing && existing.embeddingSimilarity >= r.similarity) continue

      const [source_id, target_id] = key.split('::')
      pairMap.set(key, { source_id, target_id, embeddingSimilarity: r.similarity })
    }
  }

  return [...pairMap.values()]
}
