import type { Database } from 'bun:sqlite'

export default {
  version: 9,
  apply(db: Database, opts: { isMemory: boolean }): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS pending_embeddings (
        thought_id TEXT PRIMARY KEY REFERENCES thoughts(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        attempts  INTEGER DEFAULT 0,
        last_error TEXT
      )
    `)

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_thoughts_insert_pending
      AFTER INSERT ON thoughts
      BEGIN
        INSERT OR REPLACE INTO pending_embeddings (thought_id, created_at)
        VALUES (NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      END;

      CREATE TRIGGER IF NOT EXISTS trg_thoughts_update_pending
      AFTER UPDATE OF content ON thoughts
      BEGIN
        INSERT OR REPLACE INTO pending_embeddings (thought_id, created_at)
        VALUES (NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      END;
    `)

    if (!opts.isMemory) {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_thoughts_delete_vec
        AFTER DELETE ON thoughts
        BEGIN
          DELETE FROM vec_thoughts WHERE id = OLD.id;
        END;
      `)

      db.run(`
        INSERT OR IGNORE INTO pending_embeddings (thought_id, created_at)
        SELECT t.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM thoughts t
        LEFT JOIN vec_thoughts v ON t.id = v.id
        WHERE v.id IS NULL
      `)
    }
  }
}
