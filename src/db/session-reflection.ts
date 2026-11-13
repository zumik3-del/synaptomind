import type { Database } from 'bun:sqlite'
import { computeContentHash } from '../utils'

export interface DecisionCandidate {
  id: string
  content: string
}

export function findActiveDecisionThoughts(db: Database, projectId?: string): DecisionCandidate[] {
  return db
    .prepare(`
    SELECT t.id, t.content FROM thoughts t
    JOIN thought_tags tt ON tt.thought_id = t.id
    JOIN tags tg ON tg.id = tt.tag_id
    WHERE tg.name = 'decision' AND t.status != 'archived' AND (? IS NULL OR t.project_id = ?)
  `)
    .all(projectId ?? null, projectId ?? null) as DecisionCandidate[]
}

export function hasLiveReflectionContent(
  db: Database,
  content: string,
  projectId: string
): boolean {
  return !!db
    .prepare(`
    SELECT 1 FROM thoughts
    WHERE content_hash = ? AND project_id = ? AND status IN ('draft', 'active') LIMIT 1
  `)
    .get(computeContentHash(content, projectId), projectId)
}
