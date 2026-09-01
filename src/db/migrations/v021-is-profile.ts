import type { Database } from 'bun:sqlite'

export default {
  version: 21,
  apply(db: Database): void {
    try {
      db.run(`ALTER TABLE thoughts ADD COLUMN is_profile INTEGER DEFAULT 0`)
    } catch {
      // column already exists
    }
    db.run(`CREATE INDEX IF NOT EXISTS idx_thoughts_profile ON thoughts(is_profile) WHERE is_profile = 1`)
  }
}
