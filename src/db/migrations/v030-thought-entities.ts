import type { Database } from 'bun:sqlite'

export default {
  version: 30,
  apply(db: Database): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS thought_entities (
        thought_id  TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        entity_name TEXT NOT NULL,
        entity_type TEXT NOT NULL DEFAULT 'term',
        created_at  TEXT NOT NULL,
        PRIMARY KEY (thought_id, entity_name)
      )
    `)
    db.run(`CREATE INDEX IF NOT EXISTS idx_thought_entities_name ON thought_entities(entity_name)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_thought_entities_type ON thought_entities(entity_type)`)
  }
}
