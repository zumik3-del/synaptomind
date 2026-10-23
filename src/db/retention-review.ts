import type { Database } from 'bun:sqlite'

export interface RetentionReviewCandidateFilters {
  cutoff: string
  importanceFloor: number
  now: string
}

export interface RetentionReviewCandidateRow {
  id: string
  content: string
  status: string
  project_id: string
  project_name: string | null
  created_at: string
  archived_at: string | null
  surface_after: string | null
  importance: number
  hit_count: number
}

const where = `
  WHERE t.status IN ('archived', 'draft')
    AND COALESCE(t.archived_at, t.created_at) < ?
    AND COALESCE(ti.importance, 1.0) < ?
    AND COALESCE(ti.hit_count, 0) = 0
    AND t.is_protected = 0
    AND (t.surface_after IS NULL OR t.surface_after <= ?)
    AND COALESCE(t.is_global, 0) = 0
    AND NOT EXISTS (
      SELECT 1 FROM edges e
      JOIN thoughts s ON s.id = e.source_id
      WHERE e.target_id = t.id AND s.status = 'active'
    )
`

export function countRetentionReviewCandidates(db: Database, filters: RetentionReviewCandidateFilters): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS total
    FROM thoughts t
    LEFT JOIN thought_importance ti ON ti.thought_id = t.id
    ${where}
  `).get(filters.cutoff, filters.importanceFloor, filters.now) as { total: number } | undefined
  return row?.total ?? 0
}

export function listRetentionReviewCandidates(
  db: Database,
  filters: RetentionReviewCandidateFilters & { limit: number; offset: number }
): RetentionReviewCandidateRow[] {
  return db.prepare(`
    SELECT t.id, t.content, t.status, t.project_id, p.name AS project_name,
           t.created_at, t.archived_at, t.surface_after,
           COALESCE(ti.importance, 1.0) AS importance,
           COALESCE(ti.hit_count, 0) AS hit_count
    FROM thoughts t
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN thought_importance ti ON ti.thought_id = t.id
    ${where}
    ORDER BY COALESCE(t.archived_at, t.created_at) ASC, t.id ASC
    LIMIT ? OFFSET ?
  `).all(filters.cutoff, filters.importanceFloor, filters.now, filters.limit, filters.offset) as RetentionReviewCandidateRow[]
}
