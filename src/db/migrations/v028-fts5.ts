import type { Database } from 'bun:sqlite'

export default {
  version: 28,
  apply(db: Database): void {
    db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS thoughts_fts USING fts5(thought_id UNINDEXED, content)`)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_thoughts_fts_insert
      AFTER INSERT ON thoughts
      BEGIN
        INSERT INTO thoughts_fts (thought_id, content) VALUES (NEW.id, NEW.content);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_thoughts_fts_update
      AFTER UPDATE OF content ON thoughts
      BEGIN
        DELETE FROM thoughts_fts WHERE thought_id = NEW.id;
        INSERT INTO thoughts_fts (thought_id, content) VALUES (NEW.id, NEW.content);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_thoughts_fts_delete
      AFTER DELETE ON thoughts
      BEGIN
        DELETE FROM thoughts_fts WHERE thought_id = OLD.id;
      END;
    `)
    db.run(`
      INSERT INTO thoughts_fts (thought_id, content)
      SELECT t.id, t.content FROM thoughts t
      LEFT JOIN thoughts_fts f ON f.thought_id = t.id
      WHERE f.thought_id IS NULL
    `)
  }
}
