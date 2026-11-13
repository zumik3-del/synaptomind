import type { Database } from 'bun:sqlite'

export default {
  version: 39,
  apply(db: Database): void {
    db.exec(`ALTER TABLE thoughts ADD COLUMN surface_after TEXT`)
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_thoughts_status_surface_after ON thoughts(status, surface_after)`
    )
    db.exec(`DROP TABLE IF EXISTS smart_notes`)
  }
}
