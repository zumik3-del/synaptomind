import type { Database } from 'bun:sqlite'

export default {
  version: 16,
  apply(db: Database): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS thought_importance (
        thought_id   TEXT PRIMARY KEY REFERENCES thoughts(id) ON DELETE CASCADE,
        importance   REAL NOT NULL DEFAULT 1.0,
        hit_count    INTEGER NOT NULL DEFAULT 0,
        last_decay   TEXT NOT NULL,
        created_at   TEXT NOT NULL
      )
    `)

    db.run(`
      INSERT OR IGNORE INTO thought_importance (thought_id, importance, hit_count, last_decay, created_at)
      SELECT id, 1.0, 0, updated_at, created_at
      FROM thoughts WHERE status != 'archived'
    `)
    db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_thought_importance_insert
      AFTER INSERT ON thoughts
      BEGIN
        INSERT OR IGNORE INTO thought_importance (thought_id, importance, hit_count, last_decay, created_at)
        VALUES (NEW.id, 1.0, 0, NEW.updated_at, NEW.created_at);
      END;
    `)
  }
}
