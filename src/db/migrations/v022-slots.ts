import type { Database } from 'bun:sqlite'

export default {
  version: 22,
  apply(db: Database): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS slots (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        scope      TEXT NOT NULL CHECK (scope IN ('project','global')),
        scope_id   TEXT,
        content    TEXT NOT NULL DEFAULT '',
        max_chars  INTEGER NOT NULL DEFAULT 2000,
        updated_at TEXT NOT NULL
      )
    `)
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_slots_key ON slots(name, scope, COALESCE(scope_id, ''))`)
  }
}
