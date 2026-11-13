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
  project_name: string | null
  is_cluster: number
  created_at: string
  updated_at: string
}

const DAY_MS = 86_400_000
export const FALLBACK_RECENCY_HALF_LIFE_DAYS = 30

function recencyDecay(createdAt: string, nowMs: number, halfLifeDays: number): number {
  const created = Date.parse(createdAt)
  if (Number.isNaN(created)) return 1
  const ageDays = Math.max(0, (nowMs - created) / DAY_MS)
  return 0.5 ** (ageDays / halfLifeDays)
}

export interface SearchHydrationContext {
  vecSimById: Map<string, number>
  bm25ScoreById: Map<string, number>
  rrfScoreById: Map<string, number>
  confidenceFloor: number
}

export interface SearchRecencyContext {
  rrfMax: number
  recencyActive: boolean
  recencyWeight: number
  recencyHalfLifeDays: number
  nowMs: number
}

export function isStrongMatch(
  result: Pick<SearchResult, 'match_source' | 'similarity'>,
  floor: number
): boolean {
  if (result.match_source.includes('id')) return true
  if (result.match_source.includes('bm25')) return true
  const sim = result.similarity ?? 0
  return result.match_source.includes('embedding') && sim >= floor
}

function applyRecencyScoring(results: SearchResult[], scores: SearchRecencyContext): void {
  if (!scores.recencyActive) return
  for (const result of results) {
    const relevant =
      result.rrf_score !== undefined ? result.rrf_score / scores.rrfMax : (result.similarity ?? 0)
    const recency = recencyDecay(
      result.thought.created_at,
      scores.nowMs,
      scores.recencyHalfLifeDays
    )
    result.recency_score = recency
    result.final_score = relevant + scores.recencyWeight * recency
  }
  results.sort((a, b) => (b.final_score ?? 0) - (a.final_score ?? 0))
}

export function fetchThoughtsByIds(
  db: Database,
  orderedIds: string[],
  options: SearchOptions,
  hydration: SearchHydrationContext,
  recency: SearchRecencyContext
): SearchResult[] {
  if (orderedIds.length === 0) return []
  const ph = sqlIn(orderedIds)
  const { sql: filterSql, params } = buildFilterSQL(db, options)

  const rows = db
    .prepare(`
      SELECT t.*, p.name as project_name, ti.importance as _importance
      FROM thoughts t
      LEFT JOIN projects p ON t.project_id = p.id
      LEFT JOIN thought_importance ti ON t.id = ti.thought_id
      WHERE t.id IN (${ph}) ${filterSql}
    `)
    .all(...orderedIds, ...params) as Array<SearchRow & { _importance: number | null }>

  const tagMap = getThoughtTagsBatch(
    db,
    rows.map(r => r.id)
  )
  const byId = new Map(rows.map(r => [r.id, r]))
  const out: SearchResult[] = []
  for (const id of orderedIds) {
    const r = byId.get(id)
    if (!r) continue
    const sim = hydration.vecSimById.get(id)
    const bm25 = hydration.bm25ScoreById.get(id)
    const rrf = hydration.rrfScoreById.get(id)
    const thought = rowToThought(r as unknown as Record<string, unknown>)
    thought.tags = tagMap.get(r.id) ?? []

    const matchSource: SearchMatchSource[] = []
    if (sim !== undefined) matchSource.push('embedding')
    if (bm25 !== undefined) matchSource.push('bm25')

    const result: SearchResult = {
      thought,
      match_source: matchSource,
      low_confidence: !isStrongMatch(
        { match_source: matchSource, similarity: sim },
        hydration.confidenceFloor
      )
    }
    if (sim !== undefined) {
      result.distance = 1 - sim
      result.similarity = sim
    }
    if (rrf !== undefined) result.rrf_score = rrf
    if (bm25 !== undefined) result.bm25_score = bm25
    out.push(result)
  }
  applyRecencyScoring(out, recency)
  return out
}
