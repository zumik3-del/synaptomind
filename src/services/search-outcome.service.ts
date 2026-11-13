import type { Database } from 'bun:sqlite'
import {
  findThoughtsByIdQuery,
  type IdLookupFilters,
  ID_PREFIX_MATCH_HARD_CAP
} from '../db/search-id'
import type { SearchResult } from '../db/search'

export type SearchOutcomeReason = 'id_not_found'

export interface SearchOutcome {
  items: SearchResult[]
  matched: number
  filtered_out: number
  reason?: SearchOutcomeReason
  ambiguous?: boolean
  warnings?: string[]
}

export interface IdLookup {
  items: SearchResult[]
  ambiguous: boolean
}

export function idNotFoundWarning(query: string): string {
  return `id_not_found: "${query}" is id-shaped but no thought carries it — the answer is a normal search for that text`
}

export function runIdLookup(
  query: string,
  d: Database,
  limit?: number,
  filters?: IdLookupFilters
): IdLookup | null {
  const cap =
    limit === undefined
      ? ID_PREFIX_MATCH_HARD_CAP
      : Math.min(Math.max(Math.floor(limit), 1), ID_PREFIX_MATCH_HARD_CAP)
  const hits = findThoughtsByIdQuery(d, query, cap + 1, filters)
  if (hits === null) return null
  return {
    items: hits.length > cap ? hits.slice(0, cap) : hits,
    ambiguous: hits.length > 1
  }
}

export function keepsUnderRelevanceGate(result: SearchResult, threshold: number): boolean {
  if (threshold <= 0) return true
  if (result.match_source.includes('bm25')) return true
  return (result.relevance ?? 0) >= threshold
}
