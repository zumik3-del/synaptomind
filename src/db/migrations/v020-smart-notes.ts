import type { Database } from 'bun:sqlite'

export default {
  version: 20,
  apply(db: Database): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS smart_notes (
        id                 TEXT PRIMARY KEY,
        thought_id         TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        surface_condition  TEXT NOT NULL,
        surface_checked_at TEXT,
        created_at         TEXT NOT NULL
      )
    `)
    db.run(`CREATE INDEX IF NOT EXISTS idx_smart_notes_thought ON smart_notes(thought_id)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_smart_notes_created ON smart_notes(created_at)`)
  }
}
