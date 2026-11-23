import type { Database } from 'bun:sqlite'
import { buildFilterSQL, type FilterOptions } from './search-filters'
import type { SearchResult } from '../types/search'
import { getThoughtTagsBatch } from './tags'
import { rowToThought, THOUGHT_ROW_COLUMNS, THOUGHT_ROW_FROM, type ThoughtRow } from './thoughts'

interface ThoughtIdQuery {
  pattern: string
  exact: boolean
}

export type IdLookupFilters = FilterOptions

const ID_HEX_LENGTH = 32
export const ID_PREFIX_MATCH_HARD_CAP = 100
const ID_PREFIX_MIN_HEX_LENGTH = 13
const UUID_HYPHEN_POSITIONS = new Set([8, 12, 16, 20])

function hyphenate(hex: string): string {
  let out = ''
  for (let i = 0; i < hex.length; i++) {
    if (UUID_HYPHEN_POSITIONS.has(i)) out += '-'
    out += hex[i]
  }
  return out
}

export function parseThoughtIdQuery(raw: string): ThoughtIdQuery | null {
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === '') return null
  const hex = trimmed.replaceAll('-', '')
  if (hex.length < ID_PREFIX_MIN_HEX_LENGTH || hex.length > ID_HEX_LENGTH) return null
  if (!/^[0-9a-f]+$/.test(hex)) return null
  const exact = hex.length === ID_HEX_LENGTH
  const canonical = hyphenate(hex)
  return { pattern: exact ? canonical : `${canonical}*`, exact }
}

function clampPrefixLimit(limit: number): number {
  if (!Number.isFinite(limit)) return ID_PREFIX_MATCH_HARD_CAP
  return Math.min(Math.max(Math.floor(limit), 1), ID_PREFIX_MATCH_HARD_CAP)
}

// `GLOB` is case-sensitive against the BINARY-collated primary key and uses that index for the
// `prefix*` form; the query is lowercased first, matching the lowercase ids the system generates.
export function findThoughtsByIdQuery(
  db: Database,
  query: string,
  limit: number = ID_PREFIX_MATCH_HARD_CAP,
  filters: IdLookupFilters = {}
): SearchResult[] | null {
  const idQuery = parseThoughtIdQuery(query)
  if (!idQuery) return null
  const cap = clampPrefixLimit(limit)
  // A full id is an explicit reference and takes only the cluster shape; a prefix is a scope query
  // and carries every filter the search call itself accepts (status, project, tag, importance).
  const scope = idQuery.exact
    ? buildFilterSQL(db, { clusterFilter: filters.clusterFilter })
    : buildFilterSQL(db, {
        statusFilter: filters.statusFilter,
        projectFilter: filters.projectFilter,
        clusterFilter: filters.clusterFilter,
        minImportance: filters.minImportance,
        tagFilter: filters.tagFilter
      })

  const rows = (
    idQuery.exact
      ? db
          .prepare(`
            SELECT ${THOUGHT_ROW_COLUMNS} ${THOUGHT_ROW_FROM}
            WHERE t.id = ? ${scope.sql}
            ORDER BY t.id ASC
          `)
          .all(idQuery.pattern, ...scope.params)
      : db
          .prepare(`
            SELECT ${THOUGHT_ROW_COLUMNS} ${THOUGHT_ROW_FROM}
            LEFT JOIN thought_importance ti ON ti.thought_id = t.id
            WHERE t.id GLOB ? ${scope.sql}
            ORDER BY t.id ASC
            LIMIT ${cap}
          `)
          .all(idQuery.pattern, ...scope.params)
  ) as ThoughtRow[]

  const tagMap = getThoughtTagsBatch(
    db,
    rows.map(r => r.id)
  )
  return rows.map(row => {
    const thought = rowToThought(row)
    thought.tags = tagMap.get(row.id) ?? []
    const result: SearchResult = {
      thought,
      match_source: ['id'],
      low_confidence: false
    }
    return result
  })
}
