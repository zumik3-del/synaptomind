import { pairKey } from '../db/utils'

export interface EmbeddingNeighbor {
  id: string
  similarity: number
}

export type SearchNeighborsFn = (
  thoughtId: string,
  embedding: Float32Array,
  topK: number
) => EmbeddingNeighbor[]

interface EmbeddingNeighborPair {
  source_id: string
  target_id: string
  embeddingSimilarity: number
}

const UNSCORABLE = 0

// `model.ts` stores normalised vectors, so the dot product is the cosine; the norm and
// dimension guards keep a zero-norm row or a dimension mismatch from surfacing as NaN.
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return UNSCORABLE
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return UNSCORABLE
  return dot / Math.sqrt(normA * normB)
}

interface ScoredNeighbor {
  id: string
  score: number
}

// Memoisation is O(N²) floats — ~400 MB at N=10000, and `listClusterCandidates` is unbounded.
function similarityRow(
  candidates: Array<{ id: string }>,
  embeddings: Float32Array[],
  cache: Map<string, Float32Array>,
  candidateId: string
): Float32Array | null {
  const own = candidates.findIndex(c => c.id === candidateId)
  if (own === -1) return null
  const cached = cache.get(candidateId)
  if (cached) return cached
  const row = new Float32Array(candidates.length)
  for (let j = 0; j < candidates.length; j++) {
    row[j] = j === own ? 1 : cosineSimilarity(embeddings[own], embeddings[j])
  }
  cache.set(candidateId, row)
  return row
}

// The neighbour universe is the candidate set, not the whole index, so this returns a
// superset of the old LIMIT-topK path: it can add pairs, never drop one.
function inMemoryNeighborLookup(
  candidates: Array<{ id: string }>,
  embeddings: Float32Array[],
  mode: 'similarity' | 'distance'
): (candidateId: string, topK: number) => ScoredNeighbor[] {
  const cache = new Map<string, Float32Array>()
  return (candidateId, topK) => {
    const row = similarityRow(candidates, embeddings, cache, candidateId)
    if (!row) return []
    const others: ScoredNeighbor[] = []
    for (let j = 0; j < candidates.length; j++) {
      if (candidates[j].id === candidateId) continue
      others.push({ id: candidates[j].id, score: mode === 'similarity' ? row[j] : 1 - row[j] })
    }
    const k =
      Number.isFinite(topK) && topK > 0 ? Math.min(Math.floor(topK), others.length) : others.length
    // Order is not semantic for either consumer, so an untruncated result skips the sort.
    if (k >= others.length) return others
    return others
      .sort((a, b) => (mode === 'similarity' ? b.score - a.score : a.score - b.score))
      .slice(0, k)
  }
}

export function buildInMemoryNeighborLookup(
  candidates: Array<{ id: string }>,
  embeddings: Float32Array[]
): SearchNeighborsFn {
  const lookup = inMemoryNeighborLookup(candidates, embeddings, 'similarity')
  return (_thoughtId, _embedding, topK) =>
    lookup(_thoughtId, topK).map(n => ({ id: n.id, similarity: n.score }))
}

export function buildInMemoryDistanceLookup(
  candidates: Array<{ id: string }>,
  embeddings: Float32Array[]
): (candidateId: string, topK: number) => Array<{ id: string; distance: number }> {
  const lookup = inMemoryNeighborLookup(candidates, embeddings, 'distance')
  return (candidateId, topK) =>
    lookup(candidateId, topK).map(n => ({ id: n.id, distance: n.score }))
}

// Neighbour-search failures are swallowed so a broken vector index degrades to "no pairs".
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
      if ((r.similarity ?? 0) < minSimilarity) continue

      const key = pairKey(candidates[i].id, r.id)
      const existing = pairMap.get(key)
      if (existing && existing.embeddingSimilarity >= r.similarity) continue

      const [source_id, target_id] = key.split('::')
      pairMap.set(key, { source_id, target_id, embeddingSimilarity: r.similarity })
    }
  }

  return [...pairMap.values()]
}
