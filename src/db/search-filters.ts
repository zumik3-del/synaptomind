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

/** `status`, `cluster` and `importance` — the predicates that are not project scope. */
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

/**
 * The partition predicate for the vec0 leg (ADR 2026-11-12): a project-scoped
 * search ranks inside the addressed project plus the global partition, so recall
 * stops depending on how many foreign rows rank nearer. The alias `v` must be
 * `vec_thoughts`. Empty when no project is addressed — the unscoped leg keeps
 * today's single global walk.
 */
export function buildVecScopeSQL(options: FilterOptions): SqlFragment {
  if (!options.projectFilter) return { sql: '', params: [] }
  return { sql: `AND v.scope IN (?, '${VEC_SCOPE_GLOBAL}') `, params: [options.projectFilter] }
}

/**
 * Build the shared `AND ...` filter fragment (and its bindings) applied to both
 * the vector and BM25 legs. The alias `t` must be the `thoughts` table in the
 * consuming query.
 */
export function buildFilterSQL(options: FilterOptions): SqlFragment {
  const fragments = residualFragments(options)
  // Global thoughts (is_global = 1) are always visible from a project-scoped
  // search: the flag is a widening mechanism, never a narrowing one.
  if (options.projectFilter) {
    fragments.splice(options.statusFilter ? 1 : 0, 0, {
      sql: 'AND (t.project_id = ? OR t.is_global = 1) ',
      params: [options.projectFilter]
    })
  }
  return concat(fragments)
}

/**
 * The same predicate without its project clause. The partition count
 * (`countFilteredVectors`) uses it to drive the query from `thoughts`, where the
 * project equality is an index lookup; a `(project_id = ? OR is_global = 1)`
 * clause would defeat that index and turn the count back into a corpus scan.
 */
export function buildResidualFilterSQL(options: FilterOptions): SqlFragment {
  return concat(residualFragments(options))
}
