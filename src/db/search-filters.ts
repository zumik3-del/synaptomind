import type { SQLQueryBindings } from 'bun:sqlite'

export interface FilterOptions {
  statusFilter?: string
  projectFilter?: string
  clusterFilter?: 'only' | 'exclude'
  minImportance?: number
  excludeFlagged?: boolean
}

function getClusterFilterSQL(filter: 'only' | 'exclude'): { sql: string; params: SQLQueryBindings[] } {
  if (filter === 'only') return { sql: 'AND t.is_cluster = 1 ', params: [] }
  return { sql: 'AND (t.is_cluster IS NULL OR t.is_cluster = 0) ', params: [] }
}

/**
 * Build the shared `AND ...` filter fragment (and its bindings) applied to both
 * the vector and BM25 legs. The alias `t` must be the `thoughts` table in the
 * consuming query.
 */
export function buildFilterSQL(options: FilterOptions): { sql: string; params: SQLQueryBindings[] } {
  let sql = ''
  const params: SQLQueryBindings[] = []
  if (options.statusFilter) {
    sql += 'AND t.status = ? '
    params.push(options.statusFilter)
  }
  if (options.projectFilter) {
    sql += 'AND t.project_id = ? '
    params.push(options.projectFilter)
  }
  if (options.clusterFilter) {
    const cf = getClusterFilterSQL(options.clusterFilter)
    sql += cf.sql
    params.push(...cf.params)
  }
  if (options.minImportance !== undefined && options.minImportance > 0) {
    sql += 'AND ti.importance >= ? '
    params.push(options.minImportance)
  }
  if (options.excludeFlagged) {
    sql += 'AND NOT EXISTS (SELECT 1 FROM thought_verify tv WHERE tv.thought_id = t.id AND tv.flagged = 1) '
  }
  return { sql, params }
}
