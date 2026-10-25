import type { Database } from 'bun:sqlite'
import { findThoughtsByIdQuery } from '../db/search-id'
import type { SearchResult } from '../db/search'

/**
 * Search outcome bookkeeping, split out of `search.service.ts` to keep the
 * orchestration module under the project's 350-line convention (AGENTS.md §4).
 * Pure with respect to configuration: the caller resolves the gate threshold.
 */

/**
 * Why a search returned no rows without being a normal "nothing matched".
 * `id_not_found`: the query was an id (full UUID or a hex prefix of at least 8
 * characters) and no thought carries it — never a fallback to other rows.
 */
export type SearchOutcomeReason = 'id_not_found'

/**
 * Machine-readable search outcome. The array return of the service's
 * `searchThoughts` stays the source-compatible surface; this carries the match
 * bookkeeping the MCP envelope needs.
 */
export interface SearchOutcome {
  /** Kept results, same rows/order as `searchThoughts` would return. */
  items: SearchResult[]
  /**
   * Candidate rows that survived the scope/tag/standing filters and were handed
   * to the relevance gate (for an id lookup: the number of id matches). Not the
   * same as `items.length` — the `topK` slice trims survivors too.
   */
  matched: number
  /** Rows the relevance gate dropped (`matched` minus the gate survivors). */
  filtered_out: number
  reason?: SearchOutcomeReason
  /** An id prefix addressed more than one thought; `items` carries them by id. */
  ambiguous?: boolean
}

/**
 * Resolve an id-shaped query (see `parseThoughtIdQuery`) to its thought(s)
 * without touching the embedding or BM25 legs, any scope filter or the gate.
 * Returns `null` when the query is not id-shaped, so the caller falls through to
 * the normal search.
 *
 * An explicit id is an explicit reference: the lookup is deliberately
 * project/status-scope-free and skips the standing suppression, so a caller that
 * named the id always gets that thought back.
 */
export function runIdLookup(query: string, d: Database): SearchOutcome | null {
  const hits = findThoughtsByIdQuery(d, query)
  if (hits === null) return null
  if (hits.length === 0) {
    return { items: [], matched: 0, filtered_out: 0, reason: 'id_not_found' }
  }
  return {
    items: hits,
    matched: hits.length,
    filtered_out: 0,
    ...(hits.length > 1 ? { ambiguous: true } : {})
  }
}

/**
 * Relevance-gate predicate on the calibrated scale: a lexical (BM25) anchor and
 * an explicit id always pass, a cosine-only row passes only when its calibrated
 * `relevance` reaches the threshold. `threshold <= 0` disables the gate.
 */
export function keepsUnderRelevanceGate(result: SearchResult, threshold: number): boolean {
  if (threshold <= 0) return true
  if (result.match_source.includes('bm25') || result.match_source.includes('id')) return true
  return (result.relevance ?? 0) >= threshold
}
