import type { Database } from 'bun:sqlite'

export default {
  version: 18,
  apply(db: Database): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS primers (
        id         TEXT PRIMARY KEY,
        thought_id TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        hit_count  INTEGER NOT NULL DEFAULT 0,
        promoted_at TEXT,
        created_at TEXT NOT NULL
      )
    `)
  }
}
