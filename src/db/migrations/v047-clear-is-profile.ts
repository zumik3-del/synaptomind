import type { Database } from 'bun:sqlite'

export default {
  version: 47,
  apply(db: Database): void {
    db.exec(`DROP INDEX IF EXISTS idx_thoughts_profile`)
    db.exec(`UPDATE thoughts SET is_profile = 0 WHERE is_profile IS NOT NULL AND is_profile != 0`)
  }
}
