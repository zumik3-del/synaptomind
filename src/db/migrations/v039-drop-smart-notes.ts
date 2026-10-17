import type { Database } from 'bun:sqlite'

export default {
  version: 39,
  apply(db: Database): void {
    // Pending surfacing now lives on the thought itself: a nullable delay
    // timestamp, eligible when NULL or already due (see ADR #838).
    db.exec(`ALTER TABLE thoughts ADD COLUMN surface_after TEXT`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_thoughts_status_surface_after ON thoughts(status, surface_after)`)
    // The smart-notes subsystem is gone; the table is dropped append-only.
    db.exec(`DROP TABLE IF EXISTS smart_notes`)
  }
}
