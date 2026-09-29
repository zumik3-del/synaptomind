import type { Database } from 'bun:sqlite'
import type { Migration } from './index'

const migration: Migration = {
  version: 41,
  apply(db: Database) {
    // Run envelope for the placement-proposal queue (ADR 2026-09-29 §2.2).
    // `run_id` groups the rows accepted by one explicit triage/apply run, so
    // the queue itself is the queryable rollback manifest. Nullable: rows
    // enqueued outside a run (the whole propose/enqueue path) keep it null.
    //
    // `init.ts` records the schema version in a step *after* the migration
    // body commits, so a crash in between replays this migration. SQLite has
    // no `ADD COLUMN IF NOT EXISTS`, hence the column probe: replaying must be
    // a no-op, not a "duplicate column name" failure that blocks startup.
    const columns = db.prepare('PRAGMA table_info(placement_proposals)').all() as Array<{ name: string }>
    if (!columns.some(column => column.name === 'run_id')) {
      db.exec('ALTER TABLE placement_proposals ADD COLUMN run_id TEXT')
    }
    db.run(`CREATE INDEX IF NOT EXISTS idx_pp_run ON placement_proposals(run_id, state)`)
  }
}

export default migration
