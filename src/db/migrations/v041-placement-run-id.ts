import type { Database } from 'bun:sqlite'
import type { Migration } from './index'

const migration: Migration = {
  version: 41,
  apply(db: Database) {
    // Run envelope for the placement-proposal queue (ADR 2026-09-29 §2.2).
    // `run_id` groups the rows accepted by one explicit triage/apply run, so
    // the queue itself is the queryable rollback manifest. Nullable: rows
    // enqueued outside a run (the whole propose/enqueue path) keep it null.
    db.exec(`ALTER TABLE placement_proposals ADD COLUMN run_id TEXT`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_pp_run ON placement_proposals(run_id, state)`)
  }
}

export default migration
