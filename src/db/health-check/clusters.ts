import type { Database } from 'bun:sqlite'
import type {
  ClusterlessDense,
  EmptyCluster,
  IslandThought,
  OrphanedClusterMember,
  OverlinkedThought,
  SingletonCluster
} from './types'

export function findEmptyClusters(db: Database): EmptyCluster[] {
  return db.prepare(`
    SELECT t.id, t.content FROM thoughts t
    WHERE t.is_cluster = 1
      AND NOT EXISTS (
        SELECT 1 FROM edges e WHERE e.source_id = t.id AND e.type = 'cluster'
      )
  `).all() as EmptyCluster[]
}

export function findSingletonClusters(db: Database): SingletonCluster[] {
  return db.prepare(`
    SELECT t.id, t.content, COUNT(e.id) AS member_count
    FROM thoughts t
    LEFT JOIN edges e ON e.source_id = t.id AND e.type = 'cluster'
    WHERE t.is_cluster = 1
    GROUP BY t.id
    HAVING member_count <= 1
  `).all() as SingletonCluster[]
}

export function findOrphanedClusterMembers(db: Database): OrphanedClusterMember[] {
  return db.prepare(`
    SELECT e.target_id AS thought_id, t.content, e.id AS cluster_edge_id
    FROM edges e
    JOIN thoughts t ON t.id = e.target_id
    WHERE e.type = 'cluster'
      AND NOT EXISTS (
        SELECT 1 FROM thoughts c WHERE c.id = e.source_id AND c.is_cluster = 1
      )
  `).all() as OrphanedClusterMember[]
}

export function findClusterlessDense(db: Database, minEdges: number = 5): ClusterlessDense[] {
  return db.prepare(`
    SELECT t.id, t.content, COUNT(e.id) AS edge_count
    FROM thoughts t
    JOIN edges e ON (e.source_id = t.id OR e.target_id = t.id)
      AND e.type = 'related'
    WHERE t.is_cluster = 0
      AND t.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM edges ce
        WHERE (ce.source_id = t.id OR ce.target_id = t.id)
          AND ce.type = 'cluster'
      )
    GROUP BY t.id
    HAVING edge_count >= ?
  `).all(minEdges) as ClusterlessDense[]
}

export function findIslandThoughts(db: Database): IslandThought[] {
  return db.prepare(`
    SELECT t.id, t.content, t.status FROM thoughts t
    WHERE t.status = 'active'
      AND t.is_cluster = 0
      AND t.is_profile = 0
      AND NOT EXISTS (
        SELECT 1 FROM edges e WHERE e.source_id = t.id OR e.target_id = t.id
      )
  `).all() as IslandThought[]
}

export function findOverlinkedThoughts(db: Database, maxEdges: number = 10): OverlinkedThought[] {
  return db.prepare(`
    SELECT t.id, t.content, COUNT(e.id) AS edge_count
    FROM thoughts t
    JOIN edges e ON (e.source_id = t.id OR e.target_id = t.id)
    WHERE t.is_cluster = 0
    GROUP BY t.id
    HAVING edge_count > ?
  `).all(maxEdges) as OverlinkedThought[]
}
