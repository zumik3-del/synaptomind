import type { Database } from 'bun:sqlite'

export default {
  version: 36,
  apply(db: Database): void {
    db.exec(`ALTER TABLE thoughts ADD COLUMN archived_at TEXT`)
    db.exec(`UPDATE thoughts SET archived_at = updated_at WHERE status = 'archived' AND archived_at IS NULL`)
  }
}
