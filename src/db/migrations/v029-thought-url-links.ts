import type { Database } from 'bun:sqlite'

export default {
  version: 29,
  apply(db: Database): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS thought_url_links (
        id          TEXT PRIMARY KEY,
        thought_id  TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        key         TEXT NOT NULL,
        url         TEXT NOT NULL,
        label       TEXT NOT NULL,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        UNIQUE (thought_id, key)
      )
    `)
  }
}
