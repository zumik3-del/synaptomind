import type { Database } from 'bun:sqlite'

export default {
  version: 10,
  apply(db: Database): void {
    try {
      db.run(`ALTER TABLE pending_embeddings ADD COLUMN is_error INTEGER DEFAULT 0`)
    } catch {
      // column already exists
    }
    try {
      db.run(`ALTER TABLE pending_embeddings ADD COLUMN error TEXT`)
    } catch {
      // column already exists
    }
    db.run(`UPDATE pending_embeddings SET is_error = 1, error = last_error WHERE attempts >= 10`)
  }
}
