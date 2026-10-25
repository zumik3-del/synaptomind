import type { Database } from 'bun:sqlite'
import { buildFilterSQL } from './search-filters'
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

/**
 * Scope applied to an id lookup (task #2190).
 *
 * A **prefix** is a timestamp, not a reference: its first 12 hex characters are
 * the UUIDv7 millisecond and the 13th only the version nibble, so anybody who
 * knows roughly *when* a thought was stored can address it. A prefix therefore
 * takes the same `status`/`project` scope as any other query. A **full UUID**
 * carries the random bits and is an explicit reference, so it stays
 * project/status-free by design.
 *
 * `clusterFilter` is not a scope but a shape constraint of the requested
 * collection (the `clusters` action lists cluster thoughts and refuses
 * `is_cluster=false`): it applies to both forms, otherwise an id would answer a
 * thought the collection is defined never to contain.
 */
export interface IdLookupFilters {
  statusFilter?: string
  projectFilter?: string
  clusterFilter?: 'only' | 'exclude'
}

/** Hex length of a full UUID (the stored thought-id form). */
const ID_HEX_LENGTH = 32
/**
 * Hard cap on the rows one prefix lookup returns (task #2186).
 *
 * UUIDv7 carries a 48-bit millisecond timestamp in its first 12 hex characters,
 * so a `bulk_create` batch inserts thousands of thoughts that share them: even a
 * 13-hex prefix can address a whole batch. The lookup never answers more than
 * this many rows; the caller's `limit` caps it further, and a truncated answer is
 * reported as ambiguous.
 */
export const ID_PREFIX_MATCH_HARD_CAP = 100
/**
 * Shortest hex prefix treated as an id rather than as a word (task #2186).
 *
 * Thirteen hex characters cover the 48-bit UUIDv7 millisecond timestamp (12
 * characters) plus the version nibble, the window in which unrelated thoughts
 * still share a prefix. Below that floor a hex-looking *word* — a date token
 * `20251025`, a constant `deadbeef` — is indistinguishable from a prefix, and a
 * miss would replace a legitimate word search with an empty id answer. The floor
 * keeps those terms flowing through the semantic/lexical legs.
 */
const ID_PREFIX_MIN_HEX_LENGTH = 13
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

/** Clamp a caller-supplied prefix cap into `[1, ID_PREFIX_MATCH_HARD_CAP]`. */
function clampPrefixLimit(limit: number): number {
  if (!Number.isFinite(limit)) return ID_PREFIX_MATCH_HARD_CAP
  return Math.min(Math.max(Math.floor(limit), 1), ID_PREFIX_MATCH_HARD_CAP)
}

/**
 * Resolve an id-shaped query to `SearchResult`s (empty when nothing matches),
 * or `null` when the query is not id-shaped.
 *
 * A full UUID is an explicit reference: the lookup deliberately ignores the
 * `status`, `project`, `tag` and `min_importance` scope, because a caller that
 * named an id already chose exactly one thought and must be able to resolve it
 * from any scope. A prefix is not a reference — it is a timestamp window — so it
 * takes the `status`/`project` scope of the request (see
 * {@link IdLookupFilters}); a prefix that addresses nothing inside the scope
 * returns `[]`, which the caller treats exactly like any other id miss. The
 * `is_cluster` filter is structural and applies to both forms even though an
 * explicit reference bypasses the other scopes.
 *
 * The filter/gate layers never see these rows — the caller short-circuits on
 * them.
 *
 * A prefix answer is capped at `limit` (itself hard-capped at
 * {@link ID_PREFIX_MATCH_HARD_CAP}) so a bulk batch cannot flood the answer; the
 * exact form needs no cap because the id is the primary key.
 *
 * `low_confidence` is `false` here in the neutral "an explicit reference is an
 * exact match, not a weak similarity hit" sense; standing annotation stays with
 * the caller.
 *
 * `GLOB` is case-sensitive against the stored BINARY-collated primary key and can
 * use that index for the `prefix*` form; the query is lowercased first, which
 * matches the lowercase ids the system generates.
 */
export function findThoughtsByIdQuery(
  db: Database,
  query: string,
  limit: number = ID_PREFIX_MATCH_HARD_CAP,
  filters: IdLookupFilters = {}
): SearchResult[] | null {
  const idQuery = parseThoughtIdQuery(query)
  if (!idQuery) return null
  const cap = clampPrefixLimit(limit)
  const scope = idQuery.exact
    ? buildFilterSQL({ clusterFilter: filters.clusterFilter })
    : buildFilterSQL({
        statusFilter: filters.statusFilter,
        projectFilter: filters.projectFilter,
        clusterFilter: filters.clusterFilter
      })

  const rows = (
    idQuery.exact
      ? db
          .prepare(`
            SELECT t.*, p.name AS project_name
            FROM thoughts t
            LEFT JOIN projects p ON t.project_id = p.id
            WHERE t.id = ? ${scope.sql}
            ORDER BY t.id ASC
          `)
          .all(idQuery.pattern, ...scope.params)
      : db
          .prepare(`
            SELECT t.*, p.name AS project_name
            FROM thoughts t
            LEFT JOIN projects p ON t.project_id = p.id
            WHERE t.id GLOB ? ${scope.sql}
            ORDER BY t.id ASC
            LIMIT ${cap}
          `)
          .all(idQuery.pattern, ...scope.params)
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
