import type { Database } from 'bun:sqlite'
import { v7 as uuidv7 } from 'uuid'

export interface ThoughtVerifyEntry {
  id: string
  thought_id: string
  content_hash: string | null
  last_distance: number | null
  last_checked: string | null
  drift_threshold: number
  flagged: number
  created_at: string
}

export function createVerifyEntry(db: Database, thoughtId: string, driftThreshold = 0.25): void {
  const existing = db
    .prepare(`SELECT id FROM thought_verify WHERE thought_id = ?`)
    .get(thoughtId) as { id: string } | undefined
  if (existing) return
  const id = uuidv7()
  db.prepare(`
    INSERT INTO thought_verify (id, thought_id, drift_threshold, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, thoughtId, driftThreshold, new Date().toISOString())
}

// Arm the drift pipeline: every embedded thought that has no verify entry yet.
export function findThoughtsWithoutVerifyEntry(db: Database, limit = 500): string[] {
  const rows = db
    .prepare(`
    SELECT t.id FROM vec_thoughts v
    JOIN thoughts t ON t.id = v.id
    LEFT JOIN thought_verify tv ON tv.thought_id = t.id
    WHERE tv.id IS NULL
    LIMIT ?
  `)
    .all(limit) as { id: string }[]
  return rows.map(r => r.id)
}

export function getVerifyEntries(db: Database, limit = 500): ThoughtVerifyEntry[] {
  return db.prepare(`SELECT * FROM thought_verify ORDER BY created_at LIMIT ?`).all(limit) as ThoughtVerifyEntry[]
}

export function getVerifyEntryByThoughtId(db: Database, thoughtId: string): ThoughtVerifyEntry | undefined {
  const row = db.prepare(`SELECT * FROM thought_verify WHERE thought_id = ?`).get(thoughtId) as
    | ThoughtVerifyEntry
    | undefined
  return row
}

export function getFlaggedThoughtIds(db: Database): string[] {
  const rows = db.prepare(`SELECT thought_id FROM thought_verify WHERE flagged = 1`).all() as { thought_id: string }[]
  return rows.map(r => r.thought_id)
}

export function markFlagged(db: Database, thoughtId: string, distance: number | null): void {
  db.prepare(`
    UPDATE thought_verify
    SET flagged = 1, last_distance = ?, last_checked = ?
    WHERE thought_id = ?
  `).run(distance, new Date().toISOString(), thoughtId)
}

// A completed check that did not flag: keep the measured distance and the
// timestamp so the entry waits out the re-check cadence.
export function recordCheck(db: Database, thoughtId: string, distance: number | null): void {
  db.prepare(`
    UPDATE thought_verify
    SET flagged = 0, last_distance = ?, last_checked = ?
    WHERE thought_id = ?
  `).run(distance, new Date().toISOString(), thoughtId)
}

export function clearFlag(db: Database, thoughtId: string): void {
  db.prepare(`
    UPDATE thought_verify
    SET flagged = 0, last_distance = NULL, last_checked = NULL
    WHERE thought_id = ?
  `).run(thoughtId)
}

export function updateContentHash(db: Database, thoughtId: string, hash: string | null): void {
  db.prepare(`
    UPDATE thought_verify
    SET content_hash = ?, last_checked = ?
    WHERE thought_id = ?
  `).run(hash, new Date().toISOString(), thoughtId)
}

export function getVerifyEntriesPendingCheck(db: Database): ThoughtVerifyEntry[] {
  const oneDayAgo = new Date(Date.now() - 86400000).toISOString()
  return db
    .prepare(`
    SELECT * FROM thought_verify
    WHERE flagged = 0 AND (last_checked IS NULL OR last_checked < ?)
    ORDER BY created_at
  `)
    .all(oneDayAgo) as ThoughtVerifyEntry[]
}
