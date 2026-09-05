import type { Database } from 'bun:sqlite'
import type { Migration } from './index'

const migration: Migration = {
  version: 36,
  apply(db: Database) {
    db.exec(`ALTER TABLE thoughts ADD COLUMN archived_at TEXT`)
    db.exec(`UPDATE thoughts SET archived_at = updated_at WHERE status = 'archived' AND archived_at IS NULL`)
  }
}

export default migration
