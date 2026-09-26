import type { Database } from 'bun:sqlite'
import { buildFilterSQL } from './search-filters'
import type { SearchMatchSource, SearchOptions, SearchResult } from './search-types'
import { getThoughtTagsBatch } from './tags'
import { rowToThought } from './thoughts'
import { sqlIn } from './utils'

interface SearchRow {
  id: string
  content: string
  status: string
  source: string | null
  project_id: string
  is_cluster: number
  is_profile: number
  created_at: string
  updated_at: string
}

const DAY_MS = 86_400_000
/** Half-life applied when the caller passes a non-finite or `<= 0` value. */
export const FALLBACK_RECENCY_HALF_LIFE_DAYS = 30

/**
 * Exponential recency decay `0.5 ^ (ageDays / halfLifeDays)` ∈ (0, 1].
 * `ageDays = max(0, (nowMs - Date.parse(createdAt)) / 86_400_000)`. An
 * unparseable `createdAt` is treated as age 0 (decay 1); the result is never
 * `NaN`. `halfLifeDays` is expected strictly positive (normalised by callers).
 */
function recencyDecay(createdAt: string, nowMs: number, halfLifeDays: number): number {
  const created = Date.parse(createdAt)
  if (Number.isNaN(created)) return 1
  const ageDays = Math.max(0, (nowMs - created) / DAY_MS)
  return 0.5 ** (ageDays / halfLifeDays)
}

export interface SearchScoreContext {
  vecSimById: Map<string, number>
  bm25ScoreById: Map<string, number>
  rrfScoreById: Map<string, number>
  /**
   * RRF normalisation divisor for the combined score: `nNonEmptyLegs / (RRF_K +
   * 1)`, where `nNonEmptyLegs` is the number of non-empty fusion lists. `0` on
   * the vector-only path (unused there — `similarity` is the relevance term).
   */
  rrfMax: number
  /** Whether the recency boost is enabled (`recencyWeight > 0`); fast path when false. */
  recencyActive: boolean
  /** Recency boost weight; `<= 0` disables scoring (fast path). */
  recencyWeight: number
  /** Decay half-life in days (strictly positive). */
  recencyHalfLifeDays: number
  /** Clock used for the age computation. */
  nowMs: number
}

/**
 * Attach `recency_score`/`final_score` and re-rank by the combined score when
 * the recency boost is enabled. `relevant` is the raw RRF normalised by
 * `rrfMax` on the fused path, or `similarity` on the vector-only path. The sort
 * is stable: equal `final_score` keeps the incoming relevance order.
 */
function applyRecencyScoring(results: SearchResult[], scores: SearchScoreContext): void {
  if (!scores.recencyActive) return
  for (const result of results) {
    const relevant = result.rrf_score !== undefined ? result.rrf_score / scores.rrfMax : result.similarity
    const recency = recencyDecay(result.thought.created_at, scores.nowMs, scores.recencyHalfLifeDays)
    result.recency_score = recency
    result.final_score = relevant + scores.recencyWeight * recency
  }
  results.sort((a, b) => (b.final_score ?? 0) - (a.final_score ?? 0))
}

/**
 * Hydrate ordered ids into `SearchResult`s: load rows (re-applying the shared
 * filters), attach tags, map the score context onto the public signal fields in
 * the fixed `vector`, `bm25` leg order, then apply recency scoring/re-ranking.
 */
export function fetchThoughtsByIds(
  db: Database,
  orderedIds: string[],
  options: SearchOptions,
  scores: SearchScoreContext
): SearchResult[] {
  if (orderedIds.length === 0) return []
  const ph = sqlIn(orderedIds)
  const { sql: filterSql, params } = buildFilterSQL(options)

  const rows = db
    .prepare(`
      SELECT t.*, ti.importance as _importance
      FROM thoughts t
      LEFT JOIN thought_importance ti ON t.id = ti.thought_id
      WHERE t.id IN (${ph}) ${filterSql}
    `)
    .all(...orderedIds, ...params) as Array<SearchRow & { _importance: number | null }>

  const tagMap = getThoughtTagsBatch(db, rows.map(r => r.id))
  const byId = new Map(rows.map(r => [r.id, r]))
  const out: SearchResult[] = []
  for (const id of orderedIds) {
    const r = byId.get(id)
    if (!r) continue
    const sim = scores.vecSimById.get(id)
    const bm25 = scores.bm25ScoreById.get(id)
    const rrf = scores.rrfScoreById.get(id)
    const thought = rowToThought(r as unknown as Record<string, unknown>)
    thought.tags = tagMap.get(r.id) ?? []

    // Fixed leg order: vector, bm25.
    const matchSource: SearchMatchSource[] = []
    if (sim !== undefined) matchSource.push('vector')
    if (bm25 !== undefined) matchSource.push('bm25')

    const result: SearchResult = {
      thought,
      distance: sim !== undefined ? 1 - sim : 0,
      similarity: sim !== undefined ? sim : 0,
      match_source: matchSource
    }
    if (rrf !== undefined) result.rrf_score = rrf
    if (bm25 !== undefined) result.bm25_score = bm25
    out.push(result)
  }
  applyRecencyScoring(out, scores)
  return out
}
