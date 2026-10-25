import type { Database } from 'bun:sqlite'
import { getThoughtsBatchWithTags, type Thought } from './thoughts'
import { sqlIn } from './utils'

export function getClusterForThoughtBatch(db: Database, thoughtIds: string[]): Map<string, Thought> {
  const result = new Map<string, Thought>()
  if (thoughtIds.length === 0) return result
  const ph = sqlIn(thoughtIds)
  const edges = db
    .prepare(`SELECT target_id, source_id FROM edges WHERE target_id IN (${ph}) AND type = 'cluster'`)
    .all(...thoughtIds) as Array<{ target_id: string; source_id: string }>
  if (edges.length === 0) return result
  const clusterIds = [...new Set(edges.map(e => e.source_id))]
  const clusterMap = getThoughtsBatchWithTags(db, clusterIds)
  for (const e of edges) {
    const cluster = clusterMap.get(e.source_id)
    if (cluster) result.set(e.target_id, cluster)
  }
  return result
}

/** Cluster thought row by id; undefined when the id is not a cluster. */
export function getClusterThought(db: Database, id: string): { id: string; content: string } | undefined {
  return db.prepare(`SELECT * FROM thoughts WHERE id = ? AND is_cluster = 1`).get(id) as
    | { id: string; content: string }
    | undefined
}

export function getClusterMembers(db: Database, clusterId: string): Thought[] {
  const edges = db.prepare(`
    SELECT e.target_id
    FROM edges e
    INNER JOIN thoughts t ON e.target_id = t.id
    WHERE e.source_id = ? AND e.type = 'cluster' AND t.status != 'archived'
  `).all(clusterId) as {
    target_id: string
  }[]
  const members = getThoughtsBatchWithTags(db, edges.map(e => e.target_id))
  return edges.map(e => members.get(e.target_id)).filter(Boolean) as Thought[]
}
