import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { insertLog } from '../logging'
import { isStopword } from './stopwords'

// An empty expression must short-circuit the caller: an empty FTS5 MATCH would become a blanket match.
function toFtsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map(t =>
      t
        .trim()
        .replace(/^"+|"+$/g, '')
        .replace(/["*:()^+\-[\]\\]/g, '')
    )
    .filter(Boolean)
    .filter(t => !isStopword(t))
    .map(t => `"${t}"`)
  return tokens.length ? tokens.join(' OR ') : ''
}

export interface ScoredId {
  id: string
  score: number
}

export function bm25ScoredIds(
  db: Database,
  query: string,
  limit: number,
  throwOnError: boolean = false
): ScoredId[] {
  const fts = toFtsQuery(query)
  if (!fts) return []
  try {
    const rows = db
      .prepare(`
        SELECT thought_id, bm25(thoughts_fts) AS score
        FROM thoughts_fts
        WHERE thoughts_fts MATCH ?
        ORDER BY bm25(thoughts_fts)
        LIMIT ?
      `)
      .all(fts, limit) as Array<{ thought_id: string; score: number }>
    return rows.map(r => ({ id: r.thought_id, score: -r.score }))
  } catch (err) {
    insertLog('debug', 'search', 'bm25 search failed', {
      error: err instanceof Error ? err.message : String(err)
    })
    if (throwOnError) throw err
    return []
  }
}

export function bm25SearchIds(db: Database, query: string, limit: number): string[] {
  return bm25ScoredIds(db, query, limit).map(r => r.id)
}

// The join can make the planner drop the subquery order, so the outer `ORDER BY` must be stated.
export function bm25ScoredIdsFiltered(
  db: Database,
  query: string,
  limit: number,
  filterSql: string,
  filterParams: SQLQueryBindings[],
  throwOnError: boolean = false
): ScoredId[] {
  if (!filterSql) return bm25ScoredIds(db, query, limit, throwOnError)
  const fts = toFtsQuery(query)
  if (!fts) return []
  try {
    const oversample = Math.min(1000, limit * 3)
    const rows = db
      .prepare(`
        SELECT fts.thought_id, fts.score
        FROM (
          SELECT thought_id, bm25(thoughts_fts) AS score
          FROM thoughts_fts
          WHERE thoughts_fts MATCH ?
          ORDER BY bm25(thoughts_fts)
          LIMIT ?
        ) fts
        INNER JOIN thoughts t ON fts.thought_id = t.id
        LEFT JOIN thought_importance ti ON fts.thought_id = ti.thought_id
        WHERE 1=1 ${filterSql}
        ORDER BY fts.score, fts.thought_id
        LIMIT ?
      `)
      .all(fts, oversample, ...filterParams, limit) as Array<{ thought_id: string; score: number }>
    return rows.map(r => ({ id: r.thought_id, score: -r.score }))
  } catch (err) {
    insertLog('debug', 'search', 'bm25 filtered search failed', {
      error: err instanceof Error ? err.message : String(err)
    })
    if (throwOnError) throw err
    // The service passes `throwOnError: true` so a filtered failure surfaces as `degraded` rather
    // than silently widening the scope to the unfiltered leg; direct callers keep the fallback.
    return bm25ScoredIds(db, query, limit, throwOnError)
  }
}
