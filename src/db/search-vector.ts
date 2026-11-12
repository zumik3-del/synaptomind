import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { insertLog } from '../logging'
import type { SqlFragment } from './search-filters'

/**
 * Number of embedded thoughts the shared filters match. The vec0 KNN cuts its
 * pool before the residual predicate runs, so a short filtered result can mean
 * "outside the pool" rather than "absent"; comparing this count against the rows
 * the leg returned is how `db/search.ts` tells the two apart.
 *
 * A project-scoped count is driven from `thoughts` (project equality is an index
 * lookup, then a primary-key probe per row), so its cost follows the addressed
 * partition instead of the corpus: counting `FROM vec_thoughts` applies the
 * partition predicate as a plain scan of every vector row (measured 436 ms at
 * 100k rows vs ~0.1 ms for a five-row project).
 */
export function countFilteredVectors(
  db: Database,
  scope: SqlFragment,
  residual: SqlFragment
): number {
  const project = scope.sql ? scope.params[0] : undefined
  try {
    if (project === undefined) {
      const row = db
        .prepare(`
          SELECT COUNT(*) AS n
          FROM vec_thoughts v
          INNER JOIN thoughts t ON v.id = t.id
          LEFT JOIN thought_importance ti ON v.id = ti.thought_id
          WHERE 1=1 ${residual.sql}
        `)
        .get(...residual.params) as { n: number }
      return row.n
    }
    const row = db
      .prepare(`
        SELECT (
          SELECT COUNT(*) AS n
          FROM thoughts t
          LEFT JOIN thought_importance ti ON ti.thought_id = t.id
          WHERE t.project_id = ? ${residual.sql}
            AND EXISTS (SELECT 1 FROM vec_thoughts v WHERE v.id = t.id)
        ) + (
          SELECT COUNT(*) AS n
          FROM thoughts t
          LEFT JOIN thought_importance ti ON ti.thought_id = t.id
          WHERE t.is_global = 1 AND (t.project_id IS NULL OR t.project_id <> ?) ${residual.sql}
            AND EXISTS (SELECT 1 FROM vec_thoughts v WHERE v.id = t.id)
        ) AS n
      `)
      .get(project, ...residual.params, project, ...residual.params) as { n: number }
    return row.n
  } catch (err) {
    insertLog('debug', 'search', 'filtered vector count failed', {
      error: err instanceof Error ? err.message : String(err)
    })
    throw err
  }
}

/**
 * Vector (vec0) leg scoped by the partition fragment and the shared residual
 * filter fragment. Returns `[]` when the `vec_thoughts` table is unavailable so
 * semantic search degrades gracefully.
 *
 * `throwOnError` (default false) preserves the historical graceful-degradation
 * contract for direct callers; the DB search layer opts in so it can observe
 * the failure and surface a `degraded` signal.
 */
export function vecSearchIds(
  db: Database,
  embedding: Float32Array,
  pool: number,
  scope: SqlFragment,
  filter: SqlFragment,
  topK: number,
  throwOnError: boolean = false
): Array<{ id: string; distance: number }> {
  const embeddingBuf = Buffer.from(
    embedding.buffer as ArrayBuffer,
    embedding.byteOffset,
    embedding.byteLength
  )
  const params: SQLQueryBindings[] = [embeddingBuf, pool, ...scope.params, ...filter.params]
  try {
    const rows = db
      .prepare(`
        SELECT v.id, v.distance
        FROM vec_thoughts v
        INNER JOIN thoughts t ON v.id = t.id
        LEFT JOIN thought_importance ti ON v.id = ti.thought_id
        WHERE v.embedding MATCH ? AND v.k = ?
          ${scope.sql}${filter.sql}
        ORDER BY v.distance
        LIMIT ?
      `)
      .all(...params, topK) as Array<{ id: string; distance: number }>
    return rows
  } catch (err) {
    insertLog('debug', 'search', 'vec search failed', {
      error: err instanceof Error ? err.message : String(err)
    })
    if (throwOnError) throw err
    return []
  }
}
