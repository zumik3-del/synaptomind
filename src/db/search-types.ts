import type { GraphStanding } from './graph-annotations'
import type { Thought } from './thoughts'

export interface SearchOptions {
  embedding: Float32Array
  query?: string
  topK?: number
  statusFilter?: string
  projectFilter?: string
  clusterFilter?: 'only' | 'exclude'
  minImportance?: number
  excludeFlagged?: boolean
  hybrid?: boolean
  /**
   * Opt-in recency boost weight in `[0, 1]`. `<= 0` or non-finite disables the
   * boost entirely: no re-sort and no `recency_score`/`final_score` fields.
   * Default `0` preserves the current relevance-only ranking byte-identically.
   */
  recencyWeight?: number
  /** Decay half-life in days (strictly positive); non-finite or `<= 0` → 30. */
  recencyHalfLifeDays?: number
  /** Clock override for deterministic tests; defaults to `Date.now()`. */
  nowMs?: number
}

/** Search legs that can contribute a hit, in the fixed `match_source` order. */
export type SearchMatchSource = 'vector' | 'bm25'

export interface SearchResult {
  thought: Thought
  distance: number
  similarity: number
  /**
   * Reciprocal Rank Fusion score from the hybrid merge (higher = more
   * relevant). Present only when fusion ran — i.e. the hybrid path with a
   * query and a non-empty merge; absent on the vector-only path.
   */
  rrf_score?: number
  /**
   * FTS5 BM25 relevance score, present only for hits matched by the keyword
   * leg. Sign convention: higher = more relevant (the raw FTS5 `bm25()` value
   * is negative, so it is exposed negated).
   */
  bm25_score?: number
  /**
   * Search legs that matched this thought, always present, in the fixed order
   * `vector`, `bm25`. The vector-only path returns `['vector']`.
   */
  match_source: SearchMatchSource[]
  /**
   * Pure exponential recency decay `0.5^(ageDays / halfLifeDays)` in `[0, 1]`,
   * independent of relevance. Present only when the recency boost is enabled
   * (`recencyWeight > 0`); `1` = created at `nowMs`.
   */
  recency_score?: number
   /**
     * Combined ordering key `relevant + recencyWeight * recency_score`, in
     * `[0, 1+w]`, where `relevant = rrf_score / rrfMax` on the fused path and
     * `similarity` on the vector-only path. Present only when the recency boost
     * is enabled. `rrf_score` stays raw/un-boosted.
     */
  final_score?: number
  /** Graph standing; present only when the caller enables graph annotation. */
  standing?: GraphStanding
  /** Sources of incoming `replaces` edges (this thought is superseded). */
  superseded_by?: string[]
  /** `contradicts` partners (either direction, symmetric edge type). */
  contradicted_by?: string[]
}
