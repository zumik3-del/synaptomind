import type { Database } from 'bun:sqlite'

export default {
  version: 42,
  apply(db: Database, _opts: { isMemory: boolean; dimensions: number }): void {
    const columns = db.prepare('PRAGMA table_info(thoughts)').all() as Array<{ name: string }>
    if (!columns.some(column => column.name === 'is_global')) {
      db.exec('ALTER TABLE thoughts ADD COLUMN is_global INTEGER NOT NULL DEFAULT 0')
    }
  }
}
