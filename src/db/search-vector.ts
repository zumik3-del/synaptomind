import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { insertLog } from '../logging'

/**
 * Vector (vec0) leg scoped by the shared filter fragment. Returns `[]` when the
 * `vec_thoughts` table is unavailable so semantic search degrades gracefully.
 *
 * `throwOnError` (default false) preserves the historical graceful-degradation
 * contract for direct callers; the DB search layer opts in so it can observe
 * the failure and surface a `degraded` signal.
 */
export function vecSearchIds(
  db: Database,
  embedding: Float32Array,
  pool: number,
  filterSql: string,
  filterParams: SQLQueryBindings[],
  topK: number,
  throwOnError: boolean = false
): Array<{ id: string; distance: number }> {
  const embeddingBuf = Buffer.from(embedding.buffer as ArrayBuffer, embedding.byteOffset, embedding.byteLength)
  const params: SQLQueryBindings[] = [embeddingBuf, pool, ...filterParams]
  try {
    const rows = db
      .prepare(`
        SELECT v.id, v.distance
        FROM vec_thoughts v
        INNER JOIN thoughts t ON v.id = t.id
        LEFT JOIN thought_importance ti ON v.id = ti.thought_id
        WHERE v.embedding MATCH ? AND v.k = ?
          ${filterSql}
        ORDER BY v.distance
        LIMIT ?
      `)
      .all(...params, topK) as Array<{ id: string; distance: number }>
    return rows
  } catch (err) {
    insertLog('debug', 'search', 'vec search failed', { error: err instanceof Error ? err.message : String(err) })
    if (throwOnError) throw err
    return []
  }
}
