import type { Database } from 'bun:sqlite'
import type { Migration } from './index'

const migration: Migration = {
  version: 39,
  apply(db: Database) {
    // Pending surfacing now lives on the thought itself: a nullable delay
    // timestamp, eligible when NULL or already due (see ADR #838).
    db.exec(`ALTER TABLE thoughts ADD COLUMN surface_after TEXT`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_thoughts_status_surface_after ON thoughts(status, surface_after)`)
    // The smart-notes subsystem is gone; the table is dropped append-only.
    db.exec(`DROP TABLE IF EXISTS smart_notes`)
  }
}

export default migration
