import type { Database } from 'bun:sqlite'

// `DROP COLUMN` needs SQLite >= 3.35 (Bun 1.4.2 ships 3.53.2). The presence guard, not a
// try/catch, keeps a drop SQLite refuses loud: an index or trigger still naming the column throws.
export default {
  version: 50,
  apply(db: Database): void {
    db.exec(`DROP INDEX IF EXISTS idx_preview_tokens_target`)
    db.exec(`DROP INDEX IF EXISTS idx_thoughts_content_hash`)

    const columns = db.prepare('PRAGMA table_info(pending_embeddings)').all() as { name: string }[]
    for (const column of ['last_error', 'error']) {
      if (columns.some(entry => entry.name === column)) {
        db.exec(`ALTER TABLE pending_embeddings DROP COLUMN ${column}`)
      }
    }
  }
}
