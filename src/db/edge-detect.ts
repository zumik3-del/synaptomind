import type { Database } from 'bun:sqlite'

export interface DetectionCandidate {
  id: string
  content: string
}

const MAX_CANDIDATES_LIMIT = 1000

/**
 * Active, non-cluster thoughts that are not cluster members (clusters carry no
 * atomic claim, ADR #142 Decision 2). Optionally scoped to one project to
 * respect project isolation. Bounded so neighbour search stays cheap.
 */
export function findDetectionCandidates(
  db: Database,
  projectId: string | undefined,
  limit: number
): DetectionCandidate[] {
  const bounded = Math.min(Math.max(Math.floor(limit), 0), MAX_CANDIDATES_LIMIT)
  const base = `
    SELECT t.id, t.content
    FROM thoughts t
    WHERE t.status = 'active'
      AND (t.is_cluster IS NULL OR t.is_cluster = 0)
      AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.type = 'cluster' AND e.target_id = t.id)
  `
  if (projectId) {
    return db
      .prepare(`${base} AND t.project_id = ? ORDER BY t.created_at DESC LIMIT ${bounded}`)
      .all(projectId) as DetectionCandidate[]
  }
  return db
    .prepare(`${base} ORDER BY t.created_at DESC LIMIT ${bounded}`)
    .all() as DetectionCandidate[]
}