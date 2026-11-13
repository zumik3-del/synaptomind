import { config } from '../config'
import {
  attemptPromote,
  getPrimerByThoughtId,
  getPrimerIds,
  promoteThoughtToPrimer
} from '../db/primers'
import { getDb } from '../db'
import type { SearchResult } from '../db/search'
import { getThoughtImportance, incrementHitCount } from '../db/importance'
import type { GroupedResult } from './search.service'
import type { Database } from 'bun:sqlite'

function isFlat(r: SearchResult | GroupedResult): r is SearchResult {
  return !('cluster' in r)
}

interface SearchPostProcessOptions {
  showPrimers: boolean
}

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

export function updatePrimerHits(
  results: SearchResult[] | GroupedResult[],
  d: Database = getDb()
): void {
  const ids = extractResultIds(results)
  if (ids.length === 0) return
  for (const id of ids) {
    incrementHitCount(d, id)
    const imp = getThoughtImportance(d, id)
    if (!imp) continue
    if (getPrimerByThoughtId(d, id)) {
      promoteThoughtToPrimer(d, id, imp.hit_count)
    } else {
      attemptPromote(d, id, imp.hit_count, config.primer.promoteThreshold)
    }
  }
}

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
  const primerResults: SearchResult[] = []
  for (const pid of primerIds) {
    const existing = byId.get(pid)
    if (existing) primerResults.push(existing)
  }
  if (primerResults.length === 0) return results
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

export function postProcessSearchResults(
  results: SearchResult[] | GroupedResult[],
  opts: SearchPostProcessOptions,
  d: Database = getDb()
): SearchResult[] | GroupedResult[] {
  updatePrimerHits(results, d)
  if (!opts.showPrimers) return results
  const primerIds = getPrimerIds(d)
  if (primerIds.length === 0) return results
  return prependPrimerResults(results, primerIds)
}
