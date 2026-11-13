import type { Database } from 'bun:sqlite'
import { sqlIn } from './utils'

export type GraphStanding = 'current' | 'superseded' | 'contradicted'

interface GraphStandingInfo {
  standing: GraphStanding
  superseded_by: string[]
  contradicted_by: string[]
}

export function annotateGraphStanding(db: Database, ids: string[]): Map<string, GraphStandingInfo> {
  const standing = new Map<string, GraphStandingInfo>()
  if (ids.length === 0) return standing

  const idSet = new Set(ids)
  const ph = sqlIn(ids)

  const supersededBy = new Map<string, string[]>()
  const replaceRows = db
    .prepare(
      `SELECT target_id, source_id FROM edges WHERE type = 'replaces' AND target_id IN (${ph})`
    )
    .all(...ids) as Array<{ target_id: string; source_id: string }>
  for (const row of replaceRows) {
    const list = supersededBy.get(row.target_id)
    if (list) list.push(row.source_id)
    else supersededBy.set(row.target_id, [row.source_id])
  }

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
