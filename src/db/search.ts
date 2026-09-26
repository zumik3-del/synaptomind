import type { Database } from 'bun:sqlite'
import { bm25ScoredIds, bm25ScoredIdsFiltered } from './search-bm25'
import { buildFilterSQL } from './search-filters'
import { FALLBACK_RECENCY_HALF_LIFE_DAYS, fetchThoughtsByIds } from './search-hydrate'
import { RRF_K, rrfMerge } from './search-rrf'
import type { SearchOptions, SearchResult } from './search-types'
import { vecSearchIds } from './search-vector'

export type { SearchResult } from './search-types'
export { bm25SearchIds } from './search-bm25'
export { rrfMerge } from './search-rrf'

export function searchThoughts(db: Database, options: SearchOptions): SearchResult[] {
  const {
    embedding,
    query,
    topK = 10,
    hybrid = true,
    statusFilter,
    projectFilter,
    clusterFilter,
    minImportance,
    excludeFlagged
  } = options
  const pool = Math.min(1000, Math.max(topK * 10, topK))

  // Defensive normalisation (the service clamps first): a non-positive or
  // non-finite weight disables the boost; a non-positive/non-finite half-life
  // falls back to 30 so the decay never divides by zero.
  const recencyWeight =
    options.recencyWeight !== undefined && Number.isFinite(options.recencyWeight) && options.recencyWeight > 0
      ? options.recencyWeight
      : 0
  const recencyHalfLifeDays =
    options.recencyHalfLifeDays !== undefined &&
    Number.isFinite(options.recencyHalfLifeDays) &&
    options.recencyHalfLifeDays > 0
      ? options.recencyHalfLifeDays
      : FALLBACK_RECENCY_HALF_LIFE_DAYS
  const nowMs = options.nowMs !== undefined && Number.isFinite(options.nowMs) ? options.nowMs : Date.now()
  const recency = { recencyActive: recencyWeight > 0, recencyWeight, recencyHalfLifeDays, nowMs }

  const { sql: filterSql, params: filterParams } = buildFilterSQL({
    statusFilter,
    projectFilter,
    clusterFilter,
    minImportance,
    excludeFlagged
  })

  const vecIds = embedding.length > 0
    ? vecSearchIds(db, embedding, pool, filterSql, filterParams, topK)
    : []
  const vecSimById = new Map(vecIds.map(v => [v.id, 1 - v.distance]))

  if (!hybrid || !query) {
    return fetchThoughtsByIds(
      db,
      vecIds.map(v => v.id),
      options,
      { vecSimById, bm25ScoreById: new Map(), rrfScoreById: new Map(), rrfMax: 0, ...recency }
    )
  }

  const bm25Scored = filterSql
    ? bm25ScoredIdsFiltered(db, query, pool, filterSql, filterParams)
    : bm25ScoredIds(db, query, pool)
  const bm25ScoreById = new Map(bm25Scored.map(r => [r.id, r.score]))
  const fusionLists = [vecIds.map(v => v.id), bm25Scored.map(r => r.id)]
  // A thought ranked #1 in every non-empty list reaches the RRF maximum, so
  // normalising by it keeps `relevant` order-preserving and in `(0, 1]`.
  const rrfMax = fusionLists.filter(list => list.length > 0).length / (RRF_K + 1)
  const merged = rrfMerge(fusionLists).slice(0, topK)
  const rrfScoreById = new Map(merged.map(m => [m.id, m.score]))
  return fetchThoughtsByIds(
    db,
    merged.map(m => m.id),
    options,
    { vecSimById, bm25ScoreById, rrfScoreById, rrfMax, ...recency }
  )
}
