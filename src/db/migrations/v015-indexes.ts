import type { Database } from 'bun:sqlite'

export default {
  version: 15,
  apply(db: Database): void {
    db.run(`CREATE INDEX IF NOT EXISTS idx_thoughts_created_at ON thoughts(created_at)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_thoughts_project_status ON thoughts(project_id, status)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_pending_embeddings_queue ON pending_embeddings(is_error, created_at)`)
  }
}
