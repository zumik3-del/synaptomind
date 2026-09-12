import type { Database } from 'bun:sqlite'
import { sqlIn } from './utils'

/**
 * Graph standing of a thought in retrieval (ADR #142, item D2).
 *
 * - `superseded`  — the thought is the target of a `replaces` edge.
 * - `contradicted` — the thought participates in a `contradicts` edge, either
 *   direction (the edge type is symmetric).
 * - `current`     — neither; the thought is a live, uncontested claim.
 *
 * A thought can be both superseded and contradicted; the single enum follows
 * `superseded > contradicted > current`, while `superseded_by` and
 * `contradicted_by` stay independently populated.
 */
export type GraphStanding = 'current' | 'superseded' | 'contradicted'

export interface GraphStandingInfo {
  standing: GraphStanding
  superseded_by: string[]
  contradicted_by: string[]
}

/**
 * Batch-annotate the graph standing of `ids`, side-effect free (read-only).
 *
 * Runs exactly two queries regardless of `ids.length` (no N+1):
 *   1. incoming `replaces` edges (this thought is the target);
 *   2. `contradicts` edges in either direction.
 *
 * Every requested id is present in the returned map, defaulting to `current`
 * with empty arrays, so callers can look up without existence checks. The
 * helper is reusable by `eval/search.ts` and by the search service.
 */
export function annotateGraphStanding(db: Database, ids: string[]): Map<string, GraphStandingInfo> {
  const standing = new Map<string, GraphStandingInfo>()
  if (ids.length === 0) return standing

  const idSet = new Set(ids)
  const ph = sqlIn(ids)

  // 1) incoming `replaces` — sources that supersede this thought.
  const supersededBy = new Map<string, string[]>()
  const replaceRows = db
    .prepare(`SELECT target_id, source_id FROM edges WHERE type = 'replaces' AND target_id IN (${ph})`)
    .all(...ids) as Array<{ target_id: string; source_id: string }>
  for (const row of replaceRows) {
    const list = supersededBy.get(row.target_id)
    if (list) list.push(row.source_id)
    else supersededBy.set(row.target_id, [row.source_id])
  }

  // 2) `contradicts` edges touching any id, either direction (symmetric type).
  const contradictedBy = new Map<string, string[]>()
  const contradictRows = db
    .prepare(
      `SELECT source_id, target_id FROM edges WHERE type = 'contradicts' AND (source_id IN (${ph}) OR target_id IN (${ph}))`
    )
    .all(...ids, ...ids) as Array<{ source_id: string; target_id: string }>
  for (const row of contradictRows) {
    if (row.source_id === row.target_id) continue
    if (idSet.has(row.source_id)) {
      const list = contradictedBy.get(row.source_id)
      if (list) list.push(row.target_id)
      else contradictedBy.set(row.source_id, [row.target_id])
    }
    if (idSet.has(row.target_id)) {
      const list = contradictedBy.get(row.target_id)
      if (list) list.push(row.source_id)
      else contradictedBy.set(row.target_id, [row.source_id])
    }
  }

  for (const id of ids) {
    const supers = supersededBy.get(id) ?? []
    const contras = contradictedBy.get(id) ?? []
    standing.set(id, {
      standing: supers.length > 0 ? 'superseded' : contras.length > 0 ? 'contradicted' : 'current',
      superseded_by: supers,
      contradicted_by: contras
    })
  }
  return standing
}
