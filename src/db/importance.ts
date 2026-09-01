import type { Database } from 'bun:sqlite'
import { placeholders } from './utils'

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

export function batchGetImportance(db: Database, ids: string[]): Map<string, ThoughtImportance> {
  const map = new Map<string, ThoughtImportance>()
  if (ids.length === 0) return map
  const ph = placeholders(ids)
  const rows = db
    .prepare(`SELECT * FROM thought_importance WHERE thought_id IN (${ph})`)
    .all(...ids) as ThoughtImportance[]
  for (const r of rows) map.set(r.thought_id, r)
  return map
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

export function boostImportanceBatch(db: Database, ids: string[], delta: number): void {
  if (ids.length === 0) return
  const now = new Date().toISOString()
  const ph = placeholders(ids)
  db.prepare(`
    UPDATE thought_importance
    SET importance = MIN(importance + ?, 1.0), last_decay = ?
    WHERE thought_id IN (${ph})
  `).run(delta, now, ...ids)
}

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

export function archiveStaleLowImportance(db: Database, threshold: number, minAgeDays: number): number {
  const cutoff = new Date(Date.now() - minAgeDays * 86400000).toISOString()
  const result = db
    .prepare(`
    UPDATE thoughts
    SET status = 'archived', updated_at = ?
    WHERE id IN (
      SELECT thought_id FROM thought_importance
      WHERE importance < ? AND created_at < ?
    )
    AND status = 'active'
    AND (is_profile IS NULL OR is_profile = 0)
  `)
    .run(new Date().toISOString(), threshold, cutoff)
  return result.changes
}
