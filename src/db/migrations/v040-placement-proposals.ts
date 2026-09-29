import type { Database } from 'bun:sqlite'
import type { Migration } from './index'

const migration: Migration = {
  version: 40,
  apply(db: Database) {
    // Persisted, advisory review queue for placement proposals (ADR §2.1).
    // Not the graph and not authoritative: a durable worklist whose rows are
    // re-validated (fingerprint) before any apply. `ON DELETE CASCADE` mirrors
    // `edges` so TTL cleanup of a thought cannot orphan proposals.
    db.run(`
      CREATE TABLE IF NOT EXISTS placement_proposals (
        id                TEXT PRIMARY KEY,
        project_id        TEXT,
        source_thought_id TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        item_kind         TEXT NOT NULL,
        target_id         TEXT REFERENCES thoughts(id) ON DELETE CASCADE,
        edge_type         TEXT,
        lifecycle_action  TEXT,
        direction         TEXT,
        confidence        REAL NOT NULL,
        rationale         TEXT NOT NULL,
        rule_id           TEXT,
        payload           TEXT NOT NULL,
        state             TEXT NOT NULL DEFAULT 'pending',
        fingerprint       TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        expires_at        TEXT,
        decided_at        TEXT,
        decided_by        TEXT,
        applied_at        TEXT,
        result            TEXT
      )
    `)
    db.run(`CREATE INDEX IF NOT EXISTS idx_pp_pending ON placement_proposals(state, project_id, created_at)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_pp_source ON placement_proposals(source_thought_id, state)`)
    // One live proposal per item: the partial unique index makes enqueue
    // idempotent at the DB level (ADR §2.3).
    db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pp_dedup
        ON placement_proposals(source_thought_id, item_kind, COALESCE(target_id,''), COALESCE(edge_type,''), COALESCE(lifecycle_action,''))
        WHERE state = 'pending'
    `)
  }
}

export default migration
