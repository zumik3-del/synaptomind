import type { Database } from 'bun:sqlite'

export default {
  version: 26,
  apply(db: Database): void {
    const isoNow = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

    db.exec(`
      DROP TRIGGER IF EXISTS trg_thoughts_insert_pending;
      DROP TRIGGER IF EXISTS trg_thoughts_update_pending;

      DROP TABLE IF EXISTS _pe_old;
      ALTER TABLE pending_embeddings RENAME TO _pe_old;
    `)
    db.run(`
      CREATE TABLE pending_embeddings (
        thought_id TEXT PRIMARY KEY REFERENCES thoughts(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        attempts   INTEGER DEFAULT 0,
        last_error TEXT,
        is_error   INTEGER DEFAULT 0,
        error      TEXT
      )
    `)
    db.run(`
      INSERT INTO pending_embeddings (thought_id, created_at, attempts, last_error, is_error, error)
      SELECT thought_id,
             COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at), created_at),
             attempts, last_error, is_error, error
      FROM _pe_old
    `)
    db.run(`DROP TABLE _pe_old`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_pending_embeddings_queue ON pending_embeddings(is_error, created_at)`)
    db.exec(`
      CREATE TRIGGER trg_thoughts_insert_pending
      AFTER INSERT ON thoughts
      BEGIN
        INSERT OR REPLACE INTO pending_embeddings (thought_id, created_at)
        VALUES (NEW.id, ${isoNow});
      END;

      CREATE TRIGGER trg_thoughts_update_pending
      AFTER UPDATE OF content ON thoughts
      BEGIN
        INSERT OR REPLACE INTO pending_embeddings (thought_id, created_at)
        VALUES (NEW.id, ${isoNow});
      END;
    `)

    db.exec(`
      DROP TABLE IF EXISTS _pge_old;
      ALTER TABLE pending_git_embeddings RENAME TO _pge_old;
    `)
    db.run(`
      CREATE TABLE pending_git_embeddings (
        commit_id  TEXT PRIMARY KEY REFERENCES git_commits(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        attempts   INTEGER DEFAULT 0,
        last_error TEXT,
        is_error   INTEGER DEFAULT 0,
        error      TEXT
      )
    `)
    db.run(`
      INSERT INTO pending_git_embeddings (commit_id, created_at, attempts, last_error, is_error, error)
      SELECT commit_id,
             COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at), created_at),
             attempts, last_error, is_error, error
      FROM _pge_old
    `)
    db.run(`DROP TABLE _pge_old`)
  }
}
