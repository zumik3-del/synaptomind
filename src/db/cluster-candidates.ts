/**
 * Auto-clustering candidate pool query, split out of `thoughts.ts` so that
 * module keeps its CRUD focus and stays under the project's 350-line file
 * convention (AGENTS.md §4). `thoughts.ts` re-exports both symbols below, so
 * `auto-cluster.service.ts` keeps importing them from `../db/thoughts`.
 */

import type { Database } from 'bun:sqlite'
import { getThoughtTagsBatch, type Tag } from './tags'

export interface ClusterCandidate {
  id: string
  content: string
  status: string
  tags: Tag[]
  source: string | null
  project_id: string
  created_at: string
}

/**
 * Every thought eligible for auto-clustering, newest first.
 *
 * shortcut: the pool is unbounded (no LIMIT), while the in-memory neighbour
 * lookup scores it as an O(N^2) matrix (~36 MB at N=3000); upgrade to a bounded
 * pool or a streaming lookup when a deployment reaches a few thousand eligible
 * thoughts (task #1569, O5).
 */
export function listClusterCandidates(db: Database, minAgeDays: number): ClusterCandidate[] {
  const cutoff = new Date(Date.now() - minAgeDays * 86400000).toISOString()
  const rows = db
    .prepare(`
    SELECT t.id, t.content, t.status, t.source, t.project_id, t.created_at
    FROM thoughts t
    WHERE (t.is_cluster IS NULL OR t.is_cluster = 0)
      AND t.status IN ('draft', 'active')
      AND t.created_at < ?
      AND NOT EXISTS (
        SELECT 1 FROM edges e
        WHERE e.type = 'cluster' AND e.target_id = t.id
      )
    ORDER BY t.created_at DESC
  `)
    .all(cutoff) as {
    id: string
    content: string
    status: string
    source: string | null
    project_id: string
    created_at: string
  }[]
  const tagMap = getThoughtTagsBatch(db, rows.map(r => r.id))
  return rows.map(r => ({
    id: r.id,
    content: r.content,
    status: r.status,
    tags: tagMap.get(r.id) ?? [],
    source: r.source,
    project_id: r.project_id,
    created_at: r.created_at
  }))
}