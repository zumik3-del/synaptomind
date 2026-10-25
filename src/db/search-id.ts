import type { Database } from 'bun:sqlite'
import type { SearchResult } from './search-types'
import { getThoughtTagsBatch } from './tags'
import { rowToThought } from './thoughts'

/**
 * An id-shaped search query, normalised to the stored (canonical hyphenated)
 * thinking id form.
 *
 * `pattern` is either a full id (`exact: true`) or a canonical prefix; the
 * caller feeds it to `findThoughtsByIdQuery`.
 */
export interface ThoughtIdQuery {
  pattern: string
  exact: boolean
}

/** Hex length of a full UUID (the stored thought-id form). */
const ID_HEX_LENGTH = 32
/**
 * Shortest hex prefix treated as an id rather than as a word. Eight hex chars is
 * the shortest prefix that is practically unambiguous in a UUIDv7 namespace (the
 * first 48 bits are a millisecond timestamp, so equal prefixes share a creation
 * window) and long enough that ordinary hex-looking words are rare.
 */
const ID_PREFIX_MIN_HEX_LENGTH = 8
/** Canonical UUID hyphen positions (after these zero-based hex offsets). */
const UUID_HYPHEN_POSITIONS = new Set([8, 12, 16, 20])

function hyphenate(hex: string): string {
  let out = ''
  for (let i = 0; i < hex.length; i++) {
    if (UUID_HYPHEN_POSITIONS.has(i)) out += '-'
    out += hex[i]
  }
  return out
}

/**
 * Recognise a thought-id query: trimmed, case-insensitive, and either a full
 * UUID or a hex prefix of at least {@link ID_PREFIX_MIN_HEX_LENGTH} characters.
 * Hyphens are optional and their placement is normalised, so `01A09450` and
 * `01a09450-cc4c` address the same prefix.
 *
 * Returns `null` for anything else — ordinary words keep flowing through the
 * semantic/lexical legs.
 */
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

interface IdRow {
  id: string
  content: string
  status: string
  source: string | null
  project_id: string
  project_name: string | null
  is_cluster: number
  is_profile: number
  created_at: string
  updated_at: string
}

/**
 * Resolve an id-shaped query to `SearchResult`s (empty when nothing matches),
 * or `null` when the query is not id-shaped.
 *
 * An explicit id is an explicit reference: this lookup deliberately ignores the
 * `status`, `project`, `tag`, `is_cluster` and `min_importance` scope, because a
 * caller that named an id already chose exactly one thought and must be able to
 * resolve it from any scope. The filter/standing/gate layers never see these
 * rows — the caller short-circuits on them.
 *
 * `GLOB` is case-sensitive against the stored BINARY-collated primary key and can
 * use that index for the `prefix*` form; the query is lowercased first, which
 * matches the lowercase ids the system generates.
 */
export function findThoughtsByIdQuery(db: Database, query: string): SearchResult[] | null {
  const idQuery = parseThoughtIdQuery(query)
  if (!idQuery) return null

  const rows = (
    idQuery.exact
      ? db
          .prepare(`
            SELECT t.*, p.name AS project_name
            FROM thoughts t
            LEFT JOIN projects p ON t.project_id = p.id
            WHERE t.id = ?
            ORDER BY t.id ASC
          `)
          .all(idQuery.pattern)
      : db
          .prepare(`
            SELECT t.*, p.name AS project_name
            FROM thoughts t
            LEFT JOIN projects p ON t.project_id = p.id
            WHERE t.id GLOB ?
            ORDER BY t.id ASC
          `)
          .all(idQuery.pattern)
  ) as IdRow[]

  const tagMap = getThoughtTagsBatch(db, rows.map(r => r.id))
  return rows.map(row => {
    const thought = rowToThought(row as unknown as Record<string, unknown>)
    thought.tags = tagMap.get(row.id) ?? []
    const result: SearchResult = {
      thought,
      match_source: ['id'],
      low_confidence: false
    }
    return result
  })
}
