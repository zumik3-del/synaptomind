import type { Database } from 'bun:sqlite'
import type { Migration } from './index'

const migration: Migration = {
  version: 38,
  apply(db: Database) {
    db.exec(`DROP TABLE IF EXISTS thought_entities`)
  }
}

export default migration
