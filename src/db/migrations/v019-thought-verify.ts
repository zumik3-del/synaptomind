import type { Database } from 'bun:sqlite'

export default {
  version: 19,
  apply(db: Database): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS thought_verify (
        id               TEXT PRIMARY KEY,
        thought_id       TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        content_hash     TEXT,
        last_distance    REAL,
        last_checked     TEXT,
        drift_threshold  REAL NOT NULL DEFAULT 0.25,
        flagged          INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL
      )
    `)
    db.run(`CREATE INDEX IF NOT EXISTS idx_thought_verify_flagged ON thought_verify(flagged)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_thought_verify_thought ON thought_verify(thought_id)`)
  }
}
