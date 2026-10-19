import type { Database } from 'bun:sqlite'

export default {
  version: 37,
  apply(db: Database): void {
    db.exec(`ALTER TABLE thoughts ADD COLUMN is_protected INTEGER DEFAULT 1`)
    db.exec(`UPDATE thoughts SET is_protected = 0 WHERE status = 'archived'`)
  }
}
