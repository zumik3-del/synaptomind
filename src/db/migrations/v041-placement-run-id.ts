import type { Database } from 'bun:sqlite'

export default {
  version: 41,
  apply(db: Database): void {
    const columns = db.prepare('PRAGMA table_info(placement_proposals)').all() as Array<{
      name: string
    }>
    if (!columns.some(column => column.name === 'run_id')) {
      db.exec('ALTER TABLE placement_proposals ADD COLUMN run_id TEXT')
    }
    db.run(`CREATE INDEX IF NOT EXISTS idx_pp_run ON placement_proposals(run_id, state)`)
  }
}
