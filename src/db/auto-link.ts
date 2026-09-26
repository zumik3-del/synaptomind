import type { Database } from 'bun:sqlite'

export interface LinkCandidate {
  id: string
  content: string
  edge_count: number
}

/**
 * Find active, non-cluster thoughts with low connectivity (< 3 related edges).
 * These are the best candidates for auto-linking.
 */
export function findLinkCandidates(db: Database): LinkCandidate[] {
  return db
    .prepare(`
    SELECT id, content, edge_count FROM (
      SELECT t.id, t.content, t.created_at,
             (SELECT COUNT(*) FROM edges e
              WHERE (e.source_id = t.id OR e.target_id = t.id)
                AND e.type = 'related') as edge_count
      FROM thoughts t
      WHERE t.status = 'active'
        AND (t.is_cluster IS NULL OR t.is_cluster = 0)
        AND NOT EXISTS (
          SELECT 1 FROM edges e WHERE e.type = 'cluster' AND e.target_id = t.id
        )
    ) sub
    WHERE edge_count < 3
    ORDER BY edge_count ASC, created_at DESC
  `)
    .all() as LinkCandidate[]
}