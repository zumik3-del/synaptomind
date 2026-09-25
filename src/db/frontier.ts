import type { Database } from 'bun:sqlite'

export interface FrontierCandidateRow {
  id: string
  content: string
  created_at: string
}

/**
 * Sources that never enter the frontier (profile summaries and crystals).
 * Exported so the service applies the same exclusion to ready smart-note
 * candidates that are fetched separately.
 */
export const FRONTIER_EXCLUDED_SOURCES = ['profile-summary', 'crystal']

/**
 * Candidates tagged `directive` or `todo` that are still actionable: active or
 * draft, not a cluster, not a derived summary/crystal. Optionally scoped to one
 * project (pushed into SQL to avoid an N+1 filter in the service).
 */
export function findDirectiveCandidates(db: Database, projectId?: string): FrontierCandidateRow[] {
  let sql = `
    SELECT DISTINCT t.id, t.content, t.created_at
    FROM thoughts t
    JOIN thought_tags tt ON tt.thought_id = t.id
    JOIN tags g ON g.id = tt.tag_id AND lower(g.name) IN ('directive','todo')
    WHERE t.status IN ('active','draft')
      AND t.is_cluster = 0
      AND (t.source IS NULL OR t.source NOT IN ('profile-summary','crystal'))`
  const params: string[] = []
  if (projectId) {
    sql += ` AND t.project_id = ?`
    params.push(projectId)
  }
  return db.prepare(sql).all(...params) as FrontierCandidateRow[]
}
