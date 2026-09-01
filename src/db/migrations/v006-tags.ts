import type { Database } from 'bun:sqlite'

export default {
  version: 6,
  apply(db: Database): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS tags (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `)
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name ON tags(name COLLATE NOCASE)`)

    db.run(`
      CREATE TABLE IF NOT EXISTS thought_tags (
        thought_id TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        tag_id     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (thought_id, tag_id)
      )
    `)
  }
}
