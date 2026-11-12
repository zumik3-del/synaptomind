import type { SQLQueryBindings } from 'bun:sqlite'
import { VEC_SCOPE_GLOBAL } from './vec-schema'

export interface SqlFragment {
  sql: string
  params: SQLQueryBindings[]
}

export interface FilterOptions {
  statusFilter?: string
  projectFilter?: string
  clusterFilter?: 'only' | 'exclude'
  minImportance?: number
}

function getClusterFilterSQL(filter: 'only' | 'exclude'): SqlFragment {
  if (filter === 'only') return { sql: 'AND t.is_cluster = 1 ', params: [] }
  return { sql: 'AND (t.is_cluster IS NULL OR t.is_cluster = 0) ', params: [] }
}

function residualFragments(options: FilterOptions): SqlFragment[] {
  const fragments: SqlFragment[] = []
  if (options.statusFilter) {
    fragments.push({ sql: 'AND t.status = ? ', params: [options.statusFilter] })
  }
  if (options.clusterFilter) {
    fragments.push(getClusterFilterSQL(options.clusterFilter))
  }
  if (options.minImportance !== undefined && options.minImportance > 0) {
    fragments.push({ sql: 'AND ti.importance >= ? ', params: [options.minImportance] })
  }
  return fragments
}

function concat(fragments: SqlFragment[]): SqlFragment {
  return {
    sql: fragments.map(f => f.sql).join(''),
    params: fragments.flatMap(f => f.params)
  }
}

// The alias `v` must be `vec_thoughts`. Empty when no project is addressed (single global walk).
export function buildVecScopeSQL(options: FilterOptions): SqlFragment {
  if (!options.projectFilter) return { sql: '', params: [] }
  return { sql: `AND v.scope IN (?, '${VEC_SCOPE_GLOBAL}') `, params: [options.projectFilter] }
}

// The alias `t` must be `thoughts`. A global thought stays visible from any project: the flag
// widens, never narrows.
export function buildFilterSQL(options: FilterOptions): SqlFragment {
  const fragments = residualFragments(options)
  if (options.projectFilter) {
    fragments.splice(options.statusFilter ? 1 : 0, 0, {
      sql: 'AND (t.project_id = ? OR t.is_global = 1) ',
      params: [options.projectFilter]
    })
  }
  return concat(fragments)
}

// No project clause: `(project_id = ? OR is_global = 1)` in a count driven from `thoughts` would
// defeat the project index and turn the probe back into a corpus scan.
export function buildResidualFilterSQL(options: FilterOptions): SqlFragment {
  return concat(residualFragments(options))
}
