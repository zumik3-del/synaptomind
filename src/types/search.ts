import type { GraphStanding } from '../db/graph-annotations'
import type { FilterOptions } from '../db/search-filters'
import type { Thought } from '../db/thoughts'

export interface SearchOptions extends FilterOptions {
  embedding: Float32Array
  query?: string
  topK?: number
  hybrid?: boolean
  recencyWeight?: number
  recencyHalfLifeDays?: number
  nowMs?: number
  confidenceFloor?: number
}

export type SearchMatchSource = 'embedding' | 'bm25' | 'id'

export interface SearchResult {
  thought: Thought
  distance?: number
  similarity?: number
  rrf_score?: number
  /** FTS5 raw `bm25()` is negative, so it is exposed negated: higher = more relevant. */
  bm25_score?: number
  relevance?: number
  match_source: SearchMatchSource[]
  low_confidence: boolean
  degraded?: boolean
  recency_score?: number
  final_score?: number
  standing?: GraphStanding
  superseded_by?: string[]
  contradicted_by?: string[]
}
