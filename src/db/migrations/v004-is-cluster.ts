import type { Database } from 'bun:sqlite'

export default {
  version: 4,
  apply(db: Database): void {
    try {
      db.run(`ALTER TABLE thoughts ADD COLUMN is_cluster INTEGER DEFAULT 0`)
    } catch {
      // column already exists
    }
  }
}
