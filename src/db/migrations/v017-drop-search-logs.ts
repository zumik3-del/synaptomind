import type { Database } from 'bun:sqlite'

export default {
  version: 17,
  apply(db: Database): void {
    db.run('DROP TABLE IF EXISTS search_logs')
  }
}
