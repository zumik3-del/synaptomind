import { attemptPromote, getPrimerByThoughtId, getPrimerIds, promoteThoughtToPrimer } from '../db/primers'
import { getDb } from '../db'
import type { SearchResult } from '../db/search'
import { getThoughtImportance, incrementHitCount } from '../db/thoughts'
import type { GroupedResult } from './search.service'

/** Grouped results carry a cluster payload; flat ones do not. */
function isFlat(r: SearchResult | GroupedResult): r is SearchResult {
  return !('cluster' in r)
}

export interface SearchPostProcessOptions {
  query: string
  topK: number
  showPrimers: boolean
}

/** Extract the thought ids contained in a flat or grouped result set. */
export function extractResultIds(results: SearchResult[] | GroupedResult[]): string[] {
  const ids: string[] = []
  for (const r of results) {
    if (isFlat(r)) ids.push(r.thought.id)
    else if (r.items) {
      for (const item of r.items) ids.push(item.thought.id)
    }
  }
  return ids
}

/** FI-07: count hits and auto-promote frequently-searched thoughts to primers. */
export function updatePrimerHits(results: SearchResult[] | GroupedResult[]): void {
  const d = getDb()
  const ids = extractResultIds(results)
  if (ids.length === 0) return
  for (const id of ids) {
    incrementHitCount(d, id)
    const imp = getThoughtImportance(d, id)
    if (!imp) continue
    if (getPrimerByThoughtId(d, id)) {
      // Already a primer — keep its hit_count fresh so the slot's
      // most-hit-first ordering stays accurate.
      promoteThoughtToPrimer(d, id, imp.hit_count)
    } else {
      // Threshold-aware promotion (#221): the old code called
      // promoteThoughtToPrimer unconditionally, so PRIMER_PROMOTE_THRESHOLD
      // was never enforced — every searched thought with an importance row
      // became a primer on its first hit and architecture_decisions refilled
      // immediately after any cleanup.
      attemptPromote(d, id, imp.hit_count, 5)
    }
  }
}

/** FI-07: hoist primer thoughts to the front, preserving order. */
export function prependPrimerResults(
  results: SearchResult[] | GroupedResult[],
  primerIds: string[]
): SearchResult[] | GroupedResult[] {
  const byId = new Map<string, SearchResult>()
  for (const r of results) {
    if (isFlat(r)) byId.set(r.thought.id, r)
    else if (r.items) {
      for (const item of r.items) byId.set(item.thought.id, item)
    }
  }
  // Collect primer thoughts that are already in results, preserving order
  const primerResults: SearchResult[] = []
  for (const pid of primerIds) {
    const existing = byId.get(pid)
    if (existing) primerResults.push(existing)
  }
  if (primerResults.length === 0) return results
  // Deduplicate: remove primer entries from the tail, keep first occurrence
  const primerSet = new Set(primerResults.map(r => r.thought.id))
  const filtered = results.filter(r => {
    if (isFlat(r)) return !primerSet.has(r.thought.id)
    if (r.items) {
      r.items = r.items.filter(item => !primerSet.has(item.thought.id))
      return r.items.length > 0
    }
    return true
  })
  return [...primerResults, ...filtered]
}

/** FI-08 (#200): hoist profile thoughts when the query explicitly asks for @profile. */
export function prependProfileResults(
  results: SearchResult[] | GroupedResult[],
  query: string
): SearchResult[] | GroupedResult[] {
  if (!/@profile(-|\b)/i.test(query)) return results
  const profileResults: SearchResult[] = []
  const rest: Array<SearchResult | GroupedResult> = []
  for (const r of results) {
    if (isFlat(r) && r.thought.is_profile) profileResults.push(r)
    else rest.push(r)
  }
  if (profileResults.length === 0) return results
  return [...profileResults, ...rest]
}

/**
 * Domain pipeline shared by every search surface (issue #213 E14): hit
 * counting / primer promotion → optional primer hoisting.
 */
export function postProcessSearchResults(
  results: SearchResult[] | GroupedResult[],
  opts: SearchPostProcessOptions
): SearchResult[] | GroupedResult[] {
  const d = getDb()
  updatePrimerHits(results)
  let ordered = results
  if (opts.showPrimers) {
    const primerIds = getPrimerIds(d)
    if (primerIds.length > 0) {
      ordered = prependPrimerResults(ordered, primerIds)
    }
  }
  // Applied last so an explicit @profile query puts persona thoughts topmost.
  return prependProfileResults(ordered, opts.query)
}
