import type { Database } from 'bun:sqlite'
import { DEFAULTS } from '../config'
import { bm25ScoredIds, bm25ScoredIdsFiltered } from './search-bm25'
import { buildFilterSQL, buildResidualFilterSQL, buildVecScopeSQL } from './search-filters'
import { FALLBACK_RECENCY_HALF_LIFE_DAYS, fetchThoughtsByIds } from './search-hydrate'
import { RRF_K, rrfMerge } from './search-rrf'
import type { SearchOptions, SearchResult } from './search-types'
import { addressedProjectShutOut, countFilteredVectors, vecSearchIds } from './search-vector'

export type { SearchResult } from './search-types'
export { bm25SearchIds } from './search-bm25'
export { isStrongMatch } from './search-hydrate'
export { rrfMerge } from './search-rrf'

const CANDIDATE_POOL_MAX = 1000
const CANDIDATE_POOL_MULTIPLIER = 10

export function searchThoughts(db: Database, options: SearchOptions): SearchResult[] {
  const {
    embedding,
    query,
    topK = 10,
    hybrid = true,
    statusFilter,
    projectFilter,
    clusterFilter,
    minImportance
  } = options

  // Defensive normalisation: the service clamps first, but a direct caller's bad value must not
  // divide by zero or activate a boost it cannot score.
  const recencyWeight =
    options.recencyWeight !== undefined &&
    Number.isFinite(options.recencyWeight) &&
    options.recencyWeight > 0
      ? options.recencyWeight
      : 0
  const recencyHalfLifeDays =
    options.recencyHalfLifeDays !== undefined &&
    Number.isFinite(options.recencyHalfLifeDays) &&
    options.recencyHalfLifeDays > 0
      ? options.recencyHalfLifeDays
      : FALLBACK_RECENCY_HALF_LIFE_DAYS
  const nowMs =
    options.nowMs !== undefined && Number.isFinite(options.nowMs) ? options.nowMs : Date.now()
  const recency = { recencyActive: recencyWeight > 0, recencyWeight, recencyHalfLifeDays, nowMs }
  // Defaults come from `DEFAULTS`, not the mutable live config, so the DB fallback cannot drift.
  const confidenceFloor =
    options.confidenceFloor !== undefined && Number.isFinite(options.confidenceFloor)
      ? options.confidenceFloor
      : DEFAULTS.search.confidence.vectorFloor

  const filter = buildFilterSQL({
    statusFilter,
    projectFilter,
    clusterFilter,
    minImportance
  })
  const scope = buildVecScopeSQL({ projectFilter })
  const residual = buildResidualFilterSQL({ statusFilter, clusterFilter, minImportance })
  const filterSql = filter.sql

  // A filtered vec0 leg ranks inside the addressed partition, so `pool` is a width within the
  // project; a residual filter keeps the whole cap because those filters are still post-KNN.
  const unfilteredPool = Math.min(
    CANDIDATE_POOL_MAX,
    Math.max(topK * CANDIDATE_POOL_MULTIPLIER, topK)
  )
  const pool = filterSql ? CANDIDATE_POOL_MAX : unfilteredPool

  let degraded = false
  let vecIds: Array<{ id: string; distance: number }> = []
  if (embedding.length > 0) {
    try {
      vecIds = vecSearchIds(db, embedding, pool, scope, filter, topK, true)
    } catch {
      degraded = true
      vecIds = []
    }
    // A short filtered leg means starvation only when the filter matches more embedded rows.
    if (filterSql && vecIds.length < topK) {
      try {
        if (countFilteredVectors(db, scope, residual) > vecIds.length) degraded = true
      } catch {
        degraded = true
      }
    }
    // The reverse failure: a full topK of `__global__` rows can leave the addressed project absent.
    if (projectFilter) {
      try {
        if (addressedProjectShutOut(db, projectFilter, residual, vecIds)) degraded = true
      } catch {
        degraded = true
      }
    }
  }
  const vecSimById = new Map(vecIds.map(v => [v.id, 1 - v.distance]))

  if (!hybrid || !query) {
    const out = fetchThoughtsByIds(
      db,
      vecIds.map(v => v.id),
      options,
      { vecSimById, bm25ScoreById: new Map(), rrfScoreById: new Map(), confidenceFloor },
      { rrfMax: 0, ...recency }
    )
    Object.assign(out, { degraded })
    return out
  }

  let bm25Scored: ReturnType<typeof bm25ScoredIds> = []
  try {
    bm25Scored = filterSql
      ? bm25ScoredIdsFiltered(db, query, pool, filter.sql, filter.params, true)
      : bm25ScoredIds(db, query, pool, true)
  } catch {
    degraded = true
    bm25Scored = []
  }
  const bm25ScoreById = new Map(bm25Scored.map(r => [r.id, r.score]))
  const fusionLists = [vecIds.map(v => v.id), bm25Scored.map(r => r.id)]
  const rrfMax = fusionLists.filter(list => list.length > 0).length / (RRF_K + 1)
  const merged = rrfMerge(fusionLists).slice(0, topK)
  const rrfScoreById = new Map(merged.map(m => [m.id, m.score]))
  const out = fetchThoughtsByIds(
    db,
    merged.map(m => m.id),
    options,
    { vecSimById, bm25ScoreById, rrfScoreById, confidenceFloor },
    { rrfMax, ...recency }
  )
  Object.assign(out, { degraded })
  return out
}
