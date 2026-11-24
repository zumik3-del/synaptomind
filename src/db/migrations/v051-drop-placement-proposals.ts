import type { Database } from 'bun:sqlite'

// idx_pp_* go with the table; a same-named view still throws, so no try/catch is needed.
export default {
  version: 51,
  apply(db: Database): void {
    db.exec('DROP TABLE IF EXISTS placement_proposals')
  }
}
