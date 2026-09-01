import type { Database } from 'bun:sqlite'
import { v7 as uuidv7 } from 'uuid'

export interface SurfaceCondition {
  type: 'older_than_days' | 'has_tag' | 'has_edge_type' | 'project_status' | 'unread_for_days'
  days?: number
  tag?: string
  edge_type?: string
}

export interface SmartNote {
  id: string
  thought_id: string
  surface_condition: SurfaceCondition
  surface_checked_at: string | null
  created_at: string
}

function rowToNote(row: Record<string, unknown>): SmartNote {
  return {
    id: row.id as string,
    thought_id: row.thought_id as string,
    surface_condition: JSON.parse(row.surface_condition as string) as SurfaceCondition,
    surface_checked_at: (row.surface_checked_at as string | null) ?? null,
    created_at: row.created_at as string
  }
}

export function createSmartNote(db: Database, thoughtId: string, condition: SurfaceCondition): SmartNote {
  const id = uuidv7()
  db.prepare(`
    INSERT INTO smart_notes (id, thought_id, surface_condition, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, thoughtId, JSON.stringify(condition), new Date().toISOString())
  return getSmartNote(db, id) as SmartNote
}

export function getSmartNote(db: Database, id: string): SmartNote | undefined {
  const row = db.prepare(`SELECT * FROM smart_notes WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  return row ? rowToNote(row) : undefined
}

export function getSmartNoteByThoughtId(db: Database, thoughtId: string): SmartNote | undefined {
  const row = db.prepare(`SELECT * FROM smart_notes WHERE thought_id = ?`).get(thoughtId) as
    | Record<string, unknown>
    | undefined
  return row ? rowToNote(row) : undefined
}

export function listSmartNotes(db: Database, limit = 500): SmartNote[] {
  return (db.prepare(`SELECT * FROM smart_notes ORDER BY created_at LIMIT ?`).all(limit) as Record<string, unknown>[]).map(rowToNote)
}

export function deleteSmartNote(db: Database, id: string): boolean {
  return db.prepare(`DELETE FROM smart_notes WHERE id = ?`).run(id).changes > 0
}

export function setSurfaceCheckedAt(db: Database, id: string): void {
  db.prepare(`UPDATE smart_notes SET surface_checked_at = ? WHERE id = ?`).run(new Date().toISOString(), id)
}
