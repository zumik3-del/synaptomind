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

export interface RetentionReviewEligibilityThought {
  id: string
  content: string
  status: string
  project_id: string
  is_protected: number
  is_global: number
  is_profile: number
  created_at: string
  archived_at: string | null
  surface_after: string | null
  importance: number
  hit_count: number
}

export interface RetentionReviewDependentCounts {
  edges: number
  importance: number
  url_links: number
  pending_embeddings: number
  primers: number
  thought_tags: number
  total: number
}

export interface RetentionReviewExistingThought {
  id: string
}

export interface RetentionReviewCreatedSummaryState {
  status: string
  is_protected: number
}

export function findActiveOrDraftRetentionReviewThoughtByHash(
  db: Database,
  contentHash: string,
  projectId: string
): RetentionReviewExistingThought | undefined {
  return db.prepare(`
    SELECT id FROM thoughts
    WHERE content_hash = ? AND project_id = ? AND status IN ('draft', 'active')
    LIMIT 1
  `).get(contentHash, projectId) as RetentionReviewExistingThought | undefined
}

export function getRetentionReviewCreatedSummaryState(
  db: Database,
  thoughtId: string
): RetentionReviewCreatedSummaryState | undefined {
  return db.prepare('SELECT status, is_protected FROM thoughts WHERE id = ?')
    .get(thoughtId) as RetentionReviewCreatedSummaryState | undefined
}

export function countRetentionReviewDependents(db: Database, thoughtId: string): RetentionReviewDependentCounts {
  const count = (sql: string): number => {
    const row = db.prepare(sql).get(thoughtId) as { count: number }
    return row.count
  }
  const edgeRow = db.prepare(`SELECT COUNT(*) AS count FROM edges WHERE source_id = ? OR target_id = ?`)
    .get(thoughtId, thoughtId) as { count: number }
  const edgeCount = edgeRow.count
  const importance = count(`SELECT COUNT(*) AS count FROM thought_importance WHERE thought_id = ?`)
  const url_links = count(`SELECT COUNT(*) AS count FROM thought_url_links WHERE thought_id = ?`)
  const pending_embeddings = count(`SELECT COUNT(*) AS count FROM pending_embeddings WHERE thought_id = ?`)
  const primers = count(`SELECT COUNT(*) AS count FROM primers WHERE thought_id = ?`)
  const thought_tags = count(`SELECT COUNT(*) AS count FROM thought_tags WHERE thought_id = ?`)
  const total = edgeCount + importance + url_links + pending_embeddings + primers + thought_tags
  return { edges: edgeCount, importance, url_links, pending_embeddings, primers, thought_tags, total }
}

export function getRetentionReviewEligibilityThought(
  db: Database,
  thoughtId: string
): RetentionReviewEligibilityThought | undefined {
  return db.prepare(`
    SELECT t.id, t.content, t.status, t.project_id, t.is_protected, t.is_global,
           COALESCE(t.is_profile, 0) AS is_profile,
           t.created_at, t.archived_at, t.surface_after,
           COALESCE(ti.importance, 1.0) AS importance,
           COALESCE(ti.hit_count, 0) AS hit_count
    FROM thoughts t
    LEFT JOIN thought_importance ti ON ti.thought_id = t.id
    WHERE t.id = ?
  `).get(thoughtId) as RetentionReviewEligibilityThought | undefined
}

export function countIncomingActiveRetentionReviewEdges(db: Database, thoughtId: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM edges e
    JOIN thoughts s ON s.id = e.source_id
    WHERE e.target_id = ? AND s.status = 'active'
  `).get(thoughtId) as { count: number }
  return row.count
}

const where = `
  WHERE t.status IN ('archived', 'draft')
    AND COALESCE(t.archived_at, t.created_at) < ?
    AND COALESCE(ti.importance, 1.0) < ?
    AND COALESCE(ti.hit_count, 0) = 0
    AND t.is_protected = 0
    AND (t.surface_after IS NULL OR t.surface_after <= ?)
    AND COALESCE(t.is_global, 0) = 0
    AND COALESCE(t.is_profile, 0) = 0
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
