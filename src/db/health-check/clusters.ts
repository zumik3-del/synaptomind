import type { Database } from 'bun:sqlite'
import { config } from '../../config'
import type {
  ClusterlessDense,
  EmptyCluster,
  IslandThought,
  OrphanedClusterMember,
  OverlinkedThought,
  SingletonCluster
} from './types'
import { THOUGHTS, joinIncidentEdges, noIncidentEdges, regularThoughtsWhere } from './query-builder'

export function findEmptyClusters(db: Database): EmptyCluster[] {
  return db.prepare(`
    SELECT t.id, t.content FROM ${THOUGHTS}
    WHERE t.is_cluster = 1
      AND ${noIncidentEdges({ sourceOnly: true, type: 'cluster' })}
  `).all() as EmptyCluster[]
}

export function findSingletonClusters(db: Database): SingletonCluster[] {
  return db.prepare(`
    SELECT t.id, t.content, COUNT(e.id) AS member_count
    FROM ${THOUGHTS}
    ${joinIncidentEdges({ left: true, sourceOnly: true, type: 'cluster' })}
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

/**
 * Dense regular thoughts that no cluster has picked up yet.
 *
 * `minAgeDays` mirrors `autoCluster.minAgeDays` by default: auto-cluster only
 * considers candidates older than that window, so flagging younger thoughts
 * would be a structural false positive they cannot yet be repaired from.
 * Keep the two aligned (see the registration comment in
 * `src/services/health-check.service.ts`).
 */
export function findClusterlessDense(
  db: Database,
  minEdges: number = 5,
  minAgeDays: number = config.autoCluster.minAgeDays
): ClusterlessDense[] {
  const cutoff = new Date(Date.now() - minAgeDays * 86400000).toISOString()
  return db.prepare(`
    SELECT t.id, t.content, COUNT(e.id) AS edge_count
    FROM ${THOUGHTS}
    ${joinIncidentEdges({ type: 'related' })}
    WHERE ${regularThoughtsWhere('active')}
      AND t.created_at <= ?
      AND ${noIncidentEdges({ type: 'cluster' })}
    GROUP BY t.id
    HAVING edge_count >= ?
  `).all(cutoff, minEdges) as ClusterlessDense[]
}

export function findIslandThoughts(db: Database): IslandThought[] {
  return db.prepare(`
    SELECT t.id, t.content, t.status FROM ${THOUGHTS}
    WHERE ${regularThoughtsWhere('active')}
      AND t.is_profile = 0
      AND ${noIncidentEdges()}
  `).all() as IslandThought[]
}

export function findOverlinkedThoughts(db: Database, maxEdges: number = 10): OverlinkedThought[] {
  return db.prepare(`
    SELECT t.id, t.content, COUNT(e.id) AS edge_count
    FROM ${THOUGHTS}
    ${joinIncidentEdges()}
    WHERE ${regularThoughtsWhere()}
    GROUP BY t.id
    HAVING edge_count > ?
  `).all(maxEdges) as OverlinkedThought[]
}
