import type { Database, SQLQueryBindings } from 'bun:sqlite'

function toFtsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map(t => t.trim().replace(/^"+|"+$/g, '').replace(/["*:()^+\-[\]\\]/g, ''))
    .filter(Boolean)
    .map(t => `"${t}"`)
  return tokens.length ? tokens.join(' OR ') : '""'
}

export interface ScoredId {
  id: string
  /** Relevance score, higher = more relevant (raw FTS5 `bm25()` negated). */
  score: number
}

/**
 * Internal scored BM25 leg. Exposes the raw FTS5 `bm25()` value negated so the
 * public `bm25_score` follows "higher = more relevant"; the ordering (FTS5
 * returns more negative for more relevant rows) is unchanged.
 */
export function bm25ScoredIds(db: Database, query: string, limit: number): ScoredId[] {
  try {
    const rows = db
      .prepare(`
        SELECT thought_id, bm25(thoughts_fts) AS score
        FROM thoughts_fts
        WHERE thoughts_fts MATCH ?
        ORDER BY bm25(thoughts_fts)
        LIMIT ?
      `)
      .all(toFtsQuery(query), limit) as Array<{ thought_id: string; score: number }>
    return rows.map(r => ({ id: r.thought_id, score: -r.score }))
  } catch (err) {
    console.debug('[search] bm25 search failed:', err)
    return []
  }
}

export function bm25SearchIds(db: Database, query: string, limit: number): string[] {
  return bm25ScoredIds(db, query, limit).map(r => r.id)
}

/**
 * BM25 leg scoped by the shared filter fragment. Oversamples the FTS matches
 * before joining so post-filter `topK` is still reachable, and degrades to the
 * unfiltered leg when the filtered query fails.
 */
export function bm25ScoredIdsFiltered(
  db: Database,
  query: string,
  limit: number,
  filterSql: string,
  filterParams: SQLQueryBindings[]
): ScoredId[] {
  if (!filterSql) return bm25ScoredIds(db, query, limit)
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
        LIMIT ?
      `)
      .all(toFtsQuery(query), oversample, ...filterParams, limit) as Array<{ thought_id: string; score: number }>
    return rows.map(r => ({ id: r.thought_id, score: -r.score }))
  } catch {
    return bm25ScoredIds(db, query, limit)
  }
}
