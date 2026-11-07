import type { Database } from 'bun:sqlite'
import { annotateGraphStanding, type GraphStanding } from '../db/graph-annotations'
import type { SearchResult } from '../db/search'
import type { SearchServiceOptions, SupersessionMode } from './search.service'

/**
 * Graph-standing annotation for search results (ADR #142, item D2 and item 3),
 * split out of `search.service.ts` so that module keeps its orchestration focus
 * and both files stay under the project's 350-line convention (AGENTS.md §4).
 *
 * The types are imported type-only, so there is no runtime edge back to
 * `search.service.ts` (same pattern as `search-normalize.ts`).
 */

/**
 * Rank used by `orderByStanding`: lower is better, so every `current` row
 * precedes the contested rows while the incoming relevance order is preserved
 * within each standing group.
 */
const STANDING_RANK: Record<GraphStanding, number> = {
  current: 0,
  contradicted: 1,
  superseded: 2
}

/**
 * ADR #142, item D2: attach graph standing to results after tag filtering and
 * before post-processing, so primer hoisting can never promote a suppressed
 * (superseded) thought. `suppress` drops superseded rows; `flag` keeps them
 * annotated. Contradicted results are always flagged, never suppressed —
 * contradiction is symmetric and neither endpoint is authoritative.
 *
 * `supersessionMode` here is the *effective* mode: an id lookup passes `flag`
 * even when the caller asked for `suppress`, because an explicit id must answer
 * (task #2186).
 *
 * ADR #142, item 3: results are then stably partitioned by standing so every
 * `current` row precedes the contested ones (`contradicted` then `superseded`).
 * The incoming vector/BM25/RRF relevance order is preserved within each group —
 * the ordering never re-scores relevance, so hybrid results are not reshuffled.
 */
export function applyGraphStanding(
  results: SearchResult[],
  options: Pick<SearchServiceOptions, 'supersessionMode' | 'contradictionMode'>,
  d: Database
): SearchResult[] {
  const supersessionMode: SupersessionMode = options.supersessionMode ?? 'flag'
  const contradictionMode = options.contradictionMode ?? 'flag'
  if (results.length === 0) return results
  if (supersessionMode === 'off' && contradictionMode === 'off') return results

  const standingMap = annotateGraphStanding(d, results.map(r => r.thought.id))
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

/**
 * Deterministic standing-aware ordering (ADR #142, item 3): a stable partition
 * that keeps every `current` row ahead of the contested ones while preserving
 * the incoming (vector/BM25/RRF) relevance order within each standing group.
 *
 * `similarity` is deliberately NOT used as a sort key: it is populated only from
 * the vector leg, so keyword-only results carry `0` and would be demoted
 * below every vector hit, discarding the hybrid fusion ranking.
 *
 * The recency boost is applied *upstream* (inside the DB ranking), so this
 * stable partition preserves the recency order within each standing group.
 *
 * Exported for the ordering regression test only.
 */
export function orderByStanding(results: SearchResult[]): SearchResult[] {
  return [...results].sort(
    (a, b) => STANDING_RANK[a.standing ?? 'current'] - STANDING_RANK[b.standing ?? 'current']
  )
}
