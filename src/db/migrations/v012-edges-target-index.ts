import type { Database } from 'bun:sqlite'

export default {
  version: 12,
  apply(db: Database): void {
    db.run(`CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id, type)`)
  }
}
