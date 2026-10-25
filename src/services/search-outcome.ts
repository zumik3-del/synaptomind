import type { Database } from 'bun:sqlite'
import { findThoughtsByIdQuery, type IdLookupFilters, ID_PREFIX_MATCH_HARD_CAP } from '../db/search-id'
import type { SearchResult } from '../db/search'

/**
 * Search outcome bookkeeping, split out of `search.service.ts` to keep the
 * orchestration module under the project's 350-line convention (AGENTS.md §4).
 * Pure with respect to configuration: the caller resolves the gate threshold.
 */

/**
 * Why a search returned no rows without being a normal "nothing matched".
 * `id_not_found`: the query was an id (full UUID or a hex prefix of at least 13
 * characters), no thought carries it and the fallback word search found nothing
 * either. A miss that still has a lexical/semantic answer instead reports the
 * `id_not_found` note in {@link SearchOutcome.warnings}.
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
  /** An id prefix addressed more than one thought; `items` carries the retained rows. */
  ambiguous?: boolean
  /**
   * Non-fatal notes for `meta.warnings` — today only the `id_not_found` note of
   * an id-shaped query that addressed nothing and fell back to the word search.
   */
  warnings?: string[]
}

/** What an id-shaped query resolved to. */
export interface IdLookup {
  /**
   * The addressed rows, capped at the caller's `limit` (hard-capped). Empty means
   * the query was id-shaped but no thought carries it *inside the requested
   * scope*: the caller must fall back to the normal search instead of answering
   * with nothing.
   */
  items: SearchResult[]
  /** A prefix addressed more rows than `limit` (or several rows at all). */
  ambiguous: boolean
}

/**
 * Explain an id-shaped query that addressed no thought. The answer is a *word*
 * search for the same text, so the note has to say so: a caller who reads it as
 * "nothing matched" would miss the rows the fallback did return.
 */
export function idNotFoundWarning(query: string): string {
  return `id_not_found: "${query}" is id-shaped but no thought carries it — the answer is a normal search for that text`
}

/**
 * Resolve an id-shaped query (see `parseThoughtIdQuery`) to its thought(s)
 * without touching the embedding or BM25 legs, any tag/importance filter or the
 * gate.
 *
 * Returns `null` when the query is not id-shaped, so the caller falls through to
 * the normal search. Returns an empty `items` when the query *is* id-shaped but
 * matches nothing — the caller falls back to the word search as well, because an
 * id-shaped word (`deadbeef`, a date token) must never zero out a legitimate
 * search. A miss is reported through {@link idNotFoundWarning}, never by
 * replacing the result set.
 *
 * A full UUID is an explicit reference and resolves from any project/status,
 * while a prefix is only a timestamp window and inherits the caller's
 * `status`/`project` scope (see {@link IdLookupFilters}); a prefix that addresses
 * nothing inside the scope is an id miss like any other. Standing annotation and
 * suppression stay with the caller.
 */
export function runIdLookup(query: string, d: Database, limit?: number, filters?: IdLookupFilters): IdLookup | null {
  const cap = limit === undefined ? ID_PREFIX_MATCH_HARD_CAP : Math.min(Math.max(Math.floor(limit), 1), ID_PREFIX_MATCH_HARD_CAP)
  // One row past the cap tells "exactly cap matches" apart from "more than the
  // caller asked to see", so a truncated prefix still reports as ambiguous.
  const hits = findThoughtsByIdQuery(d, query, cap + 1, filters)
  if (hits === null) return null
  return {
    items: hits.length > cap ? hits.slice(0, cap) : hits,
    ambiguous: hits.length > 1
  }
}

/**
 * Relevance-gate predicate on the calibrated scale: a lexical (BM25) anchor
 * always passes, a cosine-only row passes only when its calibrated `relevance`
 * reaches the threshold. `threshold <= 0` disables the gate.
 *
 * There is no `id` arm: an id lookup is answered before the gate runs (see
 * `runSearch`), so an id row can never reach this predicate.
 */
export function keepsUnderRelevanceGate(result: SearchResult, threshold: number): boolean {
  if (threshold <= 0) return true
  if (result.match_source.includes('bm25')) return true
  return (result.relevance ?? 0) >= threshold
}
