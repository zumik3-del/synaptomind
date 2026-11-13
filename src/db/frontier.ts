import type { Database } from 'bun:sqlite'
import { sqlIn } from './utils'

export interface FrontierCandidateRow {
  id: string
  content: string
  created_at: string
  is_pending: number
}

export const FRONTIER_EXCLUDED_SOURCES = ['profile-summary']

export function findFrontierCandidates(db: Database, projectId?: string): FrontierCandidateRow[] {
  const excludedPlaceholders = sqlIn(FRONTIER_EXCLUDED_SOURCES)
  let sql = `
    SELECT DISTINCT t.id, t.content, t.created_at,
      EXISTS (
        SELECT 1 FROM thought_tags tt2
        JOIN tags g2 ON g2.id = tt2.tag_id
        WHERE tt2.thought_id = t.id AND lower(g2.name) = 'pending'
      ) AS is_pending
    FROM thoughts t
    JOIN thought_tags tt ON tt.thought_id = t.id
    JOIN tags g ON g.id = tt.tag_id AND lower(g.name) IN ('directive','todo','pending')
    WHERE t.status IN ('active','draft')
      AND t.is_cluster = 0
      AND (t.surface_after IS NULL OR t.surface_after <= ?)
      AND (t.source IS NULL OR t.source NOT IN (${excludedPlaceholders}))`
  const params: string[] = [new Date().toISOString(), ...FRONTIER_EXCLUDED_SOURCES]
  if (projectId) {
    sql += ` AND t.project_id = ?`
    params.push(projectId)
  }
  return db.prepare(sql).all(...params) as FrontierCandidateRow[]
}
