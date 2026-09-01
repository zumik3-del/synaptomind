import type { Database } from 'bun:sqlite'

export default {
  version: 31,
  apply(db: Database): void {
    db.run(`CREATE INDEX IF NOT EXISTS idx_thoughts_status ON thoughts(status)`)
  }
}
