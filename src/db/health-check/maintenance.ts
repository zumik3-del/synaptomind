import type { Database } from 'bun:sqlite'
import { deleteThought } from '../thoughts'
import { sqlIn } from '../utils'

export function getGraphStats(db: Database): { total_thoughts: number; total_edges: number; total_clusters: number; active: number; draft: number; archived: number } {
  const thoughts = db.prepare(`SELECT COUNT(*) AS cnt FROM thoughts`).get() as { cnt: number }
  const edges = db.prepare(`SELECT COUNT(*) AS cnt FROM edges`).get() as { cnt: number }
  const clusters = db.prepare(`SELECT COUNT(*) AS cnt FROM thoughts WHERE is_cluster = 1`).get() as { cnt: number }
  const active = db.prepare(`SELECT COUNT(*) AS cnt FROM thoughts WHERE status = 'active' AND is_cluster = 0`).get() as { cnt: number }
  const draft = db.prepare(`SELECT COUNT(*) AS cnt FROM thoughts WHERE status = 'draft' AND is_cluster = 0`).get() as { cnt: number }
  const archived = db.prepare(`SELECT COUNT(*) AS cnt FROM thoughts WHERE status = 'archived' AND is_cluster = 0`).get() as { cnt: number }
  return {
    total_thoughts: thoughts.cnt,
    total_edges: edges.cnt,
    total_clusters: clusters.cnt,
    active: active.cnt,
    draft: draft.cnt,
    archived: archived.cnt
  }
}

export function deleteEdges(db: Database, edgeIds: string[]): number {
  if (edgeIds.length === 0) return 0
  const ph = sqlIn(edgeIds)
  const result = db.prepare(`DELETE FROM edges WHERE id IN (${ph})`).run(...edgeIds)
  return result.changes
}

export function deleteThoughts(db: Database, thoughtIds: string[]): number {
  if (thoughtIds.length === 0) return 0
  const ph = sqlIn(thoughtIds)
  const rows = db
    .prepare(`SELECT id FROM thoughts WHERE id IN (${ph}) AND (is_protected IS NULL OR is_protected = 0)`)
    .all(...thoughtIds) as { id: string }[]
  let deleted = 0
  const tx = db.transaction(() => {
    for (const row of rows) {
      if (deleteThought(db, row.id)) deleted++
    }
  })
  tx()
  return deleted
}
