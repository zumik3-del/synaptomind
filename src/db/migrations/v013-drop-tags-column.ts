import type { Database } from 'bun:sqlite'

export default {
  version: 13,
  apply(db: Database): void {
    try {
      db.run(`ALTER TABLE thoughts DROP COLUMN tags`)
    } catch {
      // column already gone
    }
  }
}
