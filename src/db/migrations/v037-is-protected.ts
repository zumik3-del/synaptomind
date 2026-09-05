import type { Database } from 'bun:sqlite'
import type { Migration } from './index'

const migration: Migration = {
  version: 37,
  apply(db: Database) {
    db.exec(`ALTER TABLE thoughts ADD COLUMN is_protected INTEGER DEFAULT 1`)
    db.exec(`UPDATE thoughts SET is_protected = 0 WHERE status = 'archived'`)
  }
}

export default migration
