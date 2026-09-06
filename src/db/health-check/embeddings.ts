import type { Database } from 'bun:sqlite'
import type { DeadPrimer, ImportanceOutlier, MissingEmbedding } from './types'

export function findMissingEmbeddings(db: Database): MissingEmbedding[] {
  try {
    return db.prepare(`
      SELECT t.id, t.content FROM thoughts t
      WHERE t.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM vec_thoughts v WHERE v.id = t.id
        )
    `).all() as MissingEmbedding[]
  } catch {
    return []
  }
}

export function findDeadPrimers(db: Database, _days: number = 30): DeadPrimer[] {
  return db.prepare(`
    SELECT p.thought_id, t.content, COALESCE(p.hit_count, 0) AS hit_count
    FROM primers p
    JOIN thoughts t ON t.id = p.thought_id
    WHERE COALESCE(p.hit_count, 0) = 0
  `).all() as DeadPrimer[]
}

export function findImportanceOutliers(db: Database): ImportanceOutlier[] {
  return db.prepare(`
    SELECT t.id, t.content, i.importance,
      CASE WHEN i.importance < 0.1 THEN 'low' ELSE 'high' END AS direction
    FROM thought_importance i
    JOIN thoughts t ON t.id = i.thought_id
    WHERE i.importance < 0.1 OR i.importance > 10
  `).all() as ImportanceOutlier[]
}
