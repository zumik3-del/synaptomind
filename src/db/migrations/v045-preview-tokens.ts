import type { Database } from 'bun:sqlite'

export default {
  version: 45,
  apply(db: Database): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS preview_tokens (
        token       TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        target_id   TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL
      )
    `)
    db.run(`CREATE INDEX IF NOT EXISTS idx_preview_tokens_expires ON preview_tokens(expires_at)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_preview_tokens_target ON preview_tokens(kind, target_id)`)
  }
}
