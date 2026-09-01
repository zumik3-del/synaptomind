import type { Database } from 'bun:sqlite'

export default {
  version: 32,
  apply(db: Database): void {
    try {
      db.run(`ALTER TABLE projects ADD COLUMN local_path TEXT`)
    } catch {
      // column already exists
    }
  }
}
