import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { insertLog } from '../logging'
import type { SqlFragment } from './search-filters'
import { sqlIn } from './utils'

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
 * True when a project-scoped leg shut the addressed project out of its answer:
 * none of the rows the leg delivered belongs to that project, yet project
 * thoughts matching the same residual filters are embedded.
 *
 * A full `topK` of nearer `__global__` rows hides the project entirely — the
 * partition walk's `k` cap is consumed by globals, the project's own rows never
 * reach the residual filter, and the short-leg count above never runs (the leg
 * is not short). Probing the project is what tells "the pool cut it" from "the
 * project has nothing to say". The rule is "no row of the project delivered"
 * rather than "fewer rows than it holds": a project larger than `topK` always
 * returns fewer rows than it holds, so a count comparison would flag every
 * large project. Both probes are driven from `thoughts` (primary-key lookups,
 * then one project-index probe), never from a `vec_thoughts` scan.
 */
export function addressedProjectShutOut(
  db: Database,
  project: string,
  residual: SqlFragment,
  delivered: ReadonlyArray<{ id: string }>
): boolean {
  if (delivered.length > 0) {
    const ids = delivered.map(row => row.id)
    const own = db
      .prepare(`SELECT COUNT(*) AS n FROM thoughts WHERE project_id = ? AND id IN (${sqlIn(ids)})`)
      .get(project, ...ids) as { n: number }
    if (own.n > 0) return false
  }
  const row = db
    .prepare(`
      SELECT 1 AS found
      FROM thoughts t
      LEFT JOIN thought_importance ti ON ti.thought_id = t.id
      WHERE t.project_id = ? ${residual.sql}
        AND EXISTS (SELECT 1 FROM vec_thoughts v WHERE v.id = t.id)
      LIMIT 1
    `)
    .get(project, ...residual.params) as { found: number } | null
  return row !== null
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
