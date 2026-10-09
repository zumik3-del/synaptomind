import type { Database } from 'bun:sqlite'
import type { Migration } from './index'

const migration: Migration = {
  version: 42,
  apply(db: Database) {
    // Global thoughts appear in project-scoped searches (includeGlobal).
    // Column probe for crash-replay safety (see v041 pattern).
    const columns = db.prepare('PRAGMA table_info(thoughts)').all() as Array<{ name: string }>
    if (!columns.some(column => column.name === 'is_global')) {
      db.exec('ALTER TABLE thoughts ADD COLUMN is_global INTEGER NOT NULL DEFAULT 0')
    }
  }
}

export default migration
