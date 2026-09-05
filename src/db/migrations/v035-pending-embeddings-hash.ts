import type { Database } from 'bun:sqlite'

export default {
  version: 35,
  apply(db: Database): void {
    db.exec(`
      DROP TRIGGER IF EXISTS trg_thoughts_insert_pending;
      DROP TRIGGER IF EXISTS trg_thoughts_update_pending;
    `)

    db.run(`ALTER TABLE pending_embeddings ADD COLUMN content_hash TEXT`)

    db.exec(`
      CREATE TRIGGER trg_thoughts_insert_pending
      AFTER INSERT ON thoughts
      BEGIN
        INSERT OR REPLACE INTO pending_embeddings (thought_id, created_at, content_hash)
        VALUES (NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NEW.content_hash);
      END;

      CREATE TRIGGER trg_thoughts_update_pending
      AFTER UPDATE OF content ON thoughts
      BEGIN
        INSERT OR REPLACE INTO pending_embeddings (thought_id, created_at, content_hash)
        VALUES (NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NEW.content_hash);
      END;
    `)
  }
}
