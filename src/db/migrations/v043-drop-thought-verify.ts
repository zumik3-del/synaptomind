import type { Database } from 'bun:sqlite'

export default {
  version: 43,
  apply(db: Database): void {
    db.exec(`DROP INDEX IF EXISTS idx_thought_verify_flagged`)
    db.exec(`DROP INDEX IF EXISTS idx_thought_verify_thought`)
    db.exec(`DROP TABLE IF EXISTS thought_verify`)
  }
}
