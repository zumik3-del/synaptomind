import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { parseTags } from '../utils'
import { buildFoldedTagFilterSql } from './tags'
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
  tagFilter?: string
}

function getClusterFilterSQL(filter: 'only' | 'exclude'): SqlFragment {
  if (filter === 'only') return { sql: 'AND t.is_cluster = 1 ', params: [] }
  return { sql: 'AND (t.is_cluster IS NULL OR t.is_cluster = 0) ', params: [] }
}

// `db/tags.ts` owns the folded-name predicate; this wrapper only adds the leading `AND` and the
// trailing space the search query expects between concatenated fragments.
function buildTagFilterSQL(db: Database, tagFilter: string): SqlFragment {
  const tagNames = parseTags(tagFilter)
  if (!tagNames || tagNames.length === 0) return { sql: '', params: [] }
  const fragment = buildFoldedTagFilterSql(db, tagNames)
  return { sql: `AND ${fragment.sql} `, params: fragment.params }
}

function filterFragments(
  db: Database,
  options: FilterOptions,
  includeProject: boolean
): SqlFragment[] {
  const fragments: SqlFragment[] = []
  if (options.statusFilter) {
    fragments.push({ sql: 'AND t.status = ? ', params: [options.statusFilter] })
  }
  if (includeProject && options.projectFilter) {
    fragments.push({
      sql: 'AND (t.project_id = ? OR t.is_global = 1) ',
      params: [options.projectFilter]
    })
  }
  if (options.clusterFilter) {
    fragments.push(getClusterFilterSQL(options.clusterFilter))
  }
  if (options.minImportance !== undefined && options.minImportance > 0) {
    fragments.push({ sql: 'AND ti.importance >= ? ', params: [options.minImportance] })
  }
  if (options.tagFilter) {
    const tag = buildTagFilterSQL(db, options.tagFilter)
    if (tag.sql) fragments.push(tag)
  }
  return fragments
}

function concat(fragments: SqlFragment[]): SqlFragment {
  return {
    sql: fragments.map(f => f.sql).join(''),
    params: fragments.flatMap(f => f.params)
  }
}

export function buildVecScopeSQL(options: FilterOptions): SqlFragment {
  if (!options.projectFilter) return { sql: '', params: [] }
  return { sql: `AND v.scope IN (?, '${VEC_SCOPE_GLOBAL}') `, params: [options.projectFilter] }
}

export function buildFilterSQL(db: Database, options: FilterOptions): SqlFragment {
  return concat(filterFragments(db, options, true))
}

export function buildResidualFilterSQL(db: Database, options: FilterOptions): SqlFragment {
  return concat(filterFragments(db, options, false))
}
