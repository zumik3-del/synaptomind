import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { insertLog } from '../logging'
import type { SqlFragment } from './search-filters'
import { sqlIn } from './utils'

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
    // `MATERIALIZED` is load-bearing: it makes the planner read `vec_thoughts` once and probe the
    // ids from a bloom filter, instead of a per-row virtual-table scan (task #2533).
    const row = db
      .prepare(`
        WITH vids AS MATERIALIZED (SELECT id FROM vec_thoughts)
        SELECT (
          SELECT COUNT(*) AS n
          FROM thoughts t
          LEFT JOIN thought_importance ti ON ti.thought_id = t.id
          WHERE t.project_id = ? ${residual.sql}
            AND t.id IN (SELECT id FROM vids)
        ) + (
          SELECT COUNT(*) AS n
          FROM thoughts t
          LEFT JOIN thought_importance ti ON ti.thought_id = t.id
          WHERE t.is_global = 1 AND (t.project_id IS NULL OR t.project_id <> ?) ${residual.sql}
            AND t.id IN (SELECT id FROM vids)
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
