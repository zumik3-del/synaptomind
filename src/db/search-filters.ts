import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { parseTags } from '../utils'
import { foldTagName, matchTagIdsByFoldedName } from './tags'
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

// SQLite's `NOCASE` folds ASCII only, so the comparison happens on names folded in JS
// (`db/tags.ts`): the requested names are folded here, the stored ones are read back and folded
// there. Matched ids are bound as a (requested-name key, tag id) mapping, so the AND count is over
// requested names and two stored spellings of one name (`Тег`, `тег`) count once.
function buildTagFilterSQL(db: Database, tagFilter: string): SqlFragment {
  const tagNames = parseTags(tagFilter)
  if (!tagNames || tagNames.length === 0) return { sql: '', params: [] }
  const keys = [...new Set(tagNames.map(foldTagName))]
  const matches = matchTagIdsByFoldedName(db, keys)
  if (matches.length === 0) return { sql: 'AND 1 = 0 ', params: [] }
  const mapping = matches.map(() => 'SELECT ? AS name_key, ? AS tag_id').join(' UNION ALL ')
  return {
    sql: `AND t.id IN (
        SELECT tt.thought_id
        FROM thought_tags tt
        INNER JOIN (${mapping}) m ON m.tag_id = tt.tag_id
        GROUP BY tt.thought_id
        HAVING COUNT(DISTINCT m.name_key) = ?
      ) `,
    params: [...matches.flatMap(m => [m.key, m.id]), keys.length]
  }
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
