import type { Database } from 'bun:sqlite'

export default {
  version: 38,
  apply(db: Database): void {
    db.exec(`DROP TABLE IF EXISTS thought_entities`)
  }
}
