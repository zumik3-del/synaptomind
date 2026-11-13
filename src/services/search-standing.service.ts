import type { Database } from 'bun:sqlite'
import { annotateGraphStanding, type GraphStanding } from '../db/graph-annotations'
import type { SearchResult } from '../db/search'
import type { SearchServiceOptions, SupersessionMode } from './search.service'

const STANDING_RANK: Record<GraphStanding, number> = {
  current: 0,
  contradicted: 1,
  superseded: 2
}

export function applyGraphStanding(
  results: SearchResult[],
  options: Pick<SearchServiceOptions, 'supersessionMode' | 'contradictionMode'>,
  d: Database
): SearchResult[] {
  const supersessionMode: SupersessionMode = options.supersessionMode ?? 'flag'
  const contradictionMode = options.contradictionMode ?? 'flag'
  if (results.length === 0) return results
  if (supersessionMode === 'off' && contradictionMode === 'off') return results

  const standingMap = annotateGraphStanding(
    d,
    results.map(r => r.thought.id)
  )
  const annotated: SearchResult[] = []

  for (const result of results) {
    const info = standingMap.get(result.thought.id)
    const supersededBy = supersessionMode === 'off' ? [] : (info?.superseded_by ?? [])
    const contradictedBy = contradictionMode === 'off' ? [] : (info?.contradicted_by ?? [])

    if (supersessionMode === 'suppress' && supersededBy.length > 0) continue

    const next: SearchResult = { ...result, standing: 'current' }
    if (supersededBy.length > 0) {
      next.superseded_by = supersededBy
      next.standing = 'superseded'
    } else if (contradictedBy.length > 0) {
      next.standing = 'contradicted'
    }
    if (contradictedBy.length > 0) next.contradicted_by = contradictedBy
    annotated.push(next)
  }

  return orderByStanding(annotated)
}

export function orderByStanding(results: SearchResult[]): SearchResult[] {
  return [...results].sort(
    (a, b) => STANDING_RANK[a.standing ?? 'current'] - STANDING_RANK[b.standing ?? 'current']
  )
}
