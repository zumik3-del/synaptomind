import type { Database } from 'bun:sqlite'
import type { Edge } from './edges'
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

/**
 * The outgoing `cluster` edge from `clusterId` to `thoughtId`, or `undefined`
 * when the thought is not a member. Read-only counterpart of the membership
 * write paths in cluster.service.ts.
 */
export function findClusterMemberEdge(db: Database, clusterId: string, thoughtId: string): Edge | undefined {
  return db
    .prepare('SELECT * FROM edges WHERE source_id = ? AND target_id = ? AND type = ?')
    .get(clusterId, thoughtId, 'cluster') as Edge | undefined
}

/**
 * Bulk-delete every outgoing `cluster` edge of a cluster thought. Returns the
 * number of deleted rows — the single-query counterpart of the former per-edge
 * delete loop in dissolveClusterService.
 */
export function deleteClusterEdges(db: Database, clusterId: string): number {
  const result = db.prepare('DELETE FROM edges WHERE source_id = ? AND type = ?').run(clusterId, 'cluster')
  return result.changes
}
