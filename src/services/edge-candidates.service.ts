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
 * in tests or a different index. `thoughtId` is the query thought.
 */
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

// ── In-memory neighbour lookup (no per-candidate vec0 query) ──────────────────

/** Similarity reported for a pair the comparison cannot score (zero-norm vector or dimension mismatch). */
const UNSCORABLE = 0

/**
 * Cosine *similarity* of two stored embeddings, or `UNSCORABLE` when it cannot
 * be computed. `model.ts` emits normalised vectors (`normalize: true`), so the
 * dot product IS the cosine similarity; the norms are still checked so a
 * zero-norm row or a dimension mismatch can never surface as NaN.
 */
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

/** One scored neighbour; the score is a similarity in one mode and a distance in the other. */
interface ScoredNeighbor {
  id: string
  score: number
}

/**
 * Cosine-similarity row of one candidate against every candidate, memoised.
 *
 * Scored lazily and cached per candidate: a run that traces no neighbours (for
 * example a candidate set where nothing clears the threshold) never pays for the
 * matrix, while one O(N·d) pass per queried candidate replaces the N vec0 scans
 * that each hydrated up to 1000 rows plus a 1000-id tag batch in the old shape.
 *
 * shortcut: whole-matrix memoisation is O(N^2) floats (~36 MB at N=3000/d=384,
 * ~400 MB at N=10000); upgrade to a streaming/top-k structure when the candidate
 * pool is allowed to exceed a few thousand (`listClusterCandidates` is
 * unbounded today).
 */
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

/**
 * Neighbour lookup computed in memory from the candidate embedding matrix.
 *
 * This is the default path of every caller, so a run never issues a per-candidate
 * vec0 query. The neighbour universe here is the candidate set itself, whereas
 * the index lookup it replaces ranked a WIDER universe and applied `LIMIT topK`
 * — plus the vec0 pool `k = min(1000, topK * 10)` — BEFORE intersecting with the
 * candidates (`db/search.ts`, `db/search-vector.ts`). A non-candidate row ranked
 * ahead of a
 * candidate could therefore push that candidate out of the retained window, so
 * this lookup returns a SUPERSET of the old one: it can add pairs, never drop a
 * pair the old path kept. (Formally: a candidate inside the old top-`topK` has at
 * most `topK - 1` nearer thoughts, hence at most `topK - 1` nearer candidates,
 * so it is also inside the new top-`topK`.) The superset is the intended effect
 * and it is one-way: rows already created are not undone. Whether a given run
 * actually differs depends on how many non-candidate rows outrank the
 * candidates, and that magnitude is not measured on production data.
 * A caller that injects its own `searchNeighbors` still wins over this default.
 * The same helper serves both threshold conventions, explicitly and separately:
 * `similarity` (edge-detect 0.75, auto-link 0.65 — higher is closer) and
 * `distance` (auto-cluster 0.09 — `distance = 1 - similarity`, lower is closer).
 */
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
    const k = Number.isFinite(topK) && topK > 0 ? Math.min(Math.floor(topK), others.length) : others.length
    // Order is not semantic for either current consumer, so an untruncated
    // result skips the O(N log N) sort entirely (auto-cluster always asks
    // k = N-1, so it never truncates): `groupCandidates` filters by threshold
    // and maps ids, and `findEmbeddingNeighborPairs` keeps the MAX similarity per
    // unordered pair — both order-independent. Re-check before adding a consumer
    // that reads neighbour order.
    if (k >= others.length) return others
    return others
      .sort((a, b) => (mode === 'similarity' ? b.score - a.score : a.score - b.score))
      .slice(0, k)
  }
}

/** Similarity-valued neighbour lookup for `edge-detect` / `auto-link` (higher is closer). */
export function buildInMemoryNeighborLookup(
  candidates: Array<{ id: string }>,
  embeddings: Float32Array[]
): SearchNeighborsFn {
  const lookup = inMemoryNeighborLookup(candidates, embeddings, 'similarity')
  return (_thoughtId, _embedding, topK) =>
    lookup(_thoughtId, topK).map(n => ({ id: n.id, similarity: n.score }))
}

/**
 * Distance-valued neighbour lookup for `auto-cluster` (lower is closer).
 * `distance = 1 - cosineSimilarity` is exact for the normalised vectors
 * `model.ts` stores (`vec_thoughts` uses `distance_metric=cosine`).
 */
export function buildInMemoryDistanceLookup(
  candidates: Array<{ id: string }>,
  embeddings: Float32Array[]
): (candidateId: string, topK: number) => Array<{ id: string; distance: number }> {
  const lookup = inMemoryNeighborLookup(candidates, embeddings, 'distance')
  return (candidateId, topK) => lookup(candidateId, topK).map(n => ({ id: n.id, distance: n.score }))
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
