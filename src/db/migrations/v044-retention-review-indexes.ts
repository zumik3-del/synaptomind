import type { Database } from 'bun:sqlite'

export default {
  version: 44,
  apply(db: Database): void {
    db.run(`CREATE INDEX IF NOT EXISTS idx_thoughts_status_protected_created ON thoughts(status, is_protected, created_at)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_thoughts_status_protected_archived ON thoughts(status, is_protected, archived_at)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_thought_importance_importance_hit ON thought_importance(importance, hit_count)`)
  }
}
