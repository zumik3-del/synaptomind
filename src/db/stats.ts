import type { Database } from 'bun:sqlite'

export interface DbStats {
  thoughts: number
  active_thoughts: number
  clusters: number
}

export function getStats(db: Database): DbStats {
  const row = db
    .prepare(`
      SELECT
        COUNT(*) AS thoughts,
        SUM(CASE WHEN status != 'archived' THEN 1 ELSE 0 END) AS active_thoughts,
        SUM(CASE WHEN is_cluster = 1 THEN 1 ELSE 0 END) AS clusters
      FROM thoughts
    `)
    .get() as DbStats
  return row
}
