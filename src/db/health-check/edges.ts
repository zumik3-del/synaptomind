import type { Database } from 'bun:sqlite'
import type { ClusterViolation, DuplicateEdge, OrphanEdge, SelfLoopEdge } from './types'
import { joinEdgeEndpoint } from './query-builder'

export function findOrphanEdges(db: Database): OrphanEdge[] {
  return db.prepare(`
    SELECT e.id, e.source_id, e.target_id, e.type,
      CASE
        WHEN t1.id IS NULL AND t2.id IS NULL THEN 'both'
        WHEN t1.id IS NULL THEN 'source'
        ELSE 'target'
      END AS missing_side
    FROM edges e
    ${joinEdgeEndpoint('source', 't1', true)}
    ${joinEdgeEndpoint('target', 't2', true)}
    WHERE t1.id IS NULL OR t2.id IS NULL
  `).all() as OrphanEdge[]
}

export function findSelfLoopEdges(db: Database): SelfLoopEdge[] {
  return db.prepare(`
    SELECT id, source_id, type FROM edges WHERE source_id = target_id
  `).all() as SelfLoopEdge[]
}

export function findDuplicateEdges(db: Database): DuplicateEdge[] {
  return db.prepare(`
    SELECT source_id, target_id, type, COUNT(*) as count
    FROM edges GROUP BY source_id, target_id, type HAVING count > 1
  `).all() as DuplicateEdge[]
}

export function findClusterViolations(db: Database): ClusterViolation[] {
  return db.prepare(`
    SELECT
      source.id AS thought_id, source.content, e.type AS edge_type,
      target.id AS other_id
    FROM edges e
    ${joinEdgeEndpoint('source', 'source')}
    ${joinEdgeEndpoint('target', 'target')}
    WHERE
      (e.type = 'cluster' AND (
        COALESCE(source.is_cluster, 0) != 1
        OR COALESCE(target.is_cluster, 0) = 1
      ))
      OR (e.type = 'references' AND
        COALESCE(source.is_cluster, 0) != COALESCE(target.is_cluster, 0)
      )
      OR (e.type NOT IN ('cluster', 'references') AND (
        COALESCE(source.is_cluster, 0) = 1
        OR COALESCE(target.is_cluster, 0) = 1
      ))
  `).all() as ClusterViolation[]
}
