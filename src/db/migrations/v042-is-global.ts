import type { Database } from 'bun:sqlite'

export default {
  version: 42,
  // `_opts` keeps the signature of `Migration.apply` (unused here) so callers
  // may invoke any migration uniformly.
  apply(db: Database, _opts: { isMemory: boolean; dimensions: number }): void {
    // Global thoughts appear in project-scoped searches (includeGlobal).
    // Column probe for crash-replay safety (see v041 pattern).
    const columns = db.prepare('PRAGMA table_info(thoughts)').all() as Array<{ name: string }>
    if (!columns.some(column => column.name === 'is_global')) {
      db.exec('ALTER TABLE thoughts ADD COLUMN is_global INTEGER NOT NULL DEFAULT 0')
    }
  }
}
