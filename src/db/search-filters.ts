import type { SQLQueryBindings } from 'bun:sqlite'
import { parseTags } from '../utils'
import { sqlIn } from './utils'
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

// `NOCASE` sits on the compared column: written after `IN (...)` it belongs to the IN expression
// and leaves `tg.name` on the BINARY collation (the trap in `db/thoughts.ts:322`), so `"Foo"`
// would stop matching a requested `foo`.
function buildTagFilterSQL(tagFilter: string): SqlFragment {
  const tagNames = parseTags(tagFilter)
  if (!tagNames || tagNames.length === 0) return { sql: '', params: [] }
  const distinct = [...new Set(tagNames.map(n => n.toLowerCase()))]
  return {
    sql: `AND t.id IN (
        SELECT tt.thought_id
        FROM thought_tags tt
        INNER JOIN tags tg ON tg.id = tt.tag_id
        WHERE tg.name COLLATE NOCASE IN (${sqlIn(distinct)})
        GROUP BY tt.thought_id
        HAVING COUNT(DISTINCT tg.name) = ?
      ) `,
    params: [...distinct, distinct.length]
  }
}

function filterFragments(options: FilterOptions, includeProject: boolean): SqlFragment[] {
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
    const tag = buildTagFilterSQL(options.tagFilter)
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

export function buildFilterSQL(options: FilterOptions): SqlFragment {
  return concat(filterFragments(options, true))
}

export function buildResidualFilterSQL(options: FilterOptions): SqlFragment {
  return concat(filterFragments(options, false))
}
