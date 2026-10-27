import type { Database } from 'bun:sqlite'

export interface ThoughtImportance {
  thought_id: string
  importance: number
  hit_count: number
  last_decay: string
  created_at: string
}

export function getThoughtImportance(db: Database, thoughtId: string): ThoughtImportance | undefined {
  const row = db.prepare(`SELECT * FROM thought_importance WHERE thought_id = ?`).get(thoughtId) as
    | ThoughtImportance
    | undefined
  return row
}

export function ensureImportanceRow(db: Database, thoughtId: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO thought_importance (thought_id, importance, hit_count, last_decay, created_at)
    SELECT id, 1.0, 0, updated_at, created_at FROM thoughts WHERE id = ?
  `).run(thoughtId)
}

export function boostImportance(db: Database, thoughtId: string, delta: number): void {
  ensureImportanceRow(db, thoughtId)
  db.prepare(`
    UPDATE thought_importance
    SET importance = MIN(importance + ?, 1.0), last_decay = ?
    WHERE thought_id = ?
  `).run(delta, new Date().toISOString(), thoughtId)
}

export function incrementHitCount(db: Database, thoughtId: string): void {
  ensureImportanceRow(db, thoughtId)
  db.prepare(`
    UPDATE thought_importance
    SET hit_count = hit_count + 1, last_decay = ?
    WHERE thought_id = ?
  `).run(new Date().toISOString(), thoughtId)
}

/**
 * Decay the importance of every row that has not been decayed for a day.
 *
 * The decay job used to have a second half — archiving active, unprotected
 * thoughts whose importance fell below `decay.archiveThreshold` and whose age
 * exceeded `decay.archiveMinAgeDays`. That branch was removed in task #1943.
 * It could still fire outside the `is_protected = 1` default: for rows written
 * before that default, and for cluster thoughts, which `cluster.service.ts`
 * creates with `is_protected = false`.
 */
export function decayImportance(db: Database, rate: number): void {
  const oneDayAgo = new Date(Date.now() - 86400000).toISOString()
  const now = new Date().toISOString()
  db.prepare(`
    UPDATE thought_importance
    SET importance = importance * ?, last_decay = ?
    WHERE importance > ?
      AND last_decay < ?
  `).run(rate, now, 0, oneDayAgo)
}
