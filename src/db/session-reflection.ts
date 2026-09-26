import type { Database } from 'bun:sqlite'

export interface DecisionCandidate {
  id: string
  content: string
}

/** Non-archived thoughts tagged `decision` — the dedup pool for reflections. */
export function findActiveDecisionThoughts(db: Database): DecisionCandidate[] {
  return db
    .prepare(`
    SELECT t.id, t.content FROM thoughts t
    JOIN thought_tags tt ON tt.thought_id = t.id
    JOIN tags tg ON tg.id = tt.tag_id
    WHERE tg.name = 'decision' AND t.status != 'archived'
  `)
    .all() as DecisionCandidate[]
}