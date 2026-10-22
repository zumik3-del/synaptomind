import type { Database } from 'bun:sqlite'

export default {
  version: 43,
  apply(db: Database): void {
    // The thought-verifier subsystem is retired; the table only ever held its
    // drift diagnostics, never knowledge. Append-only: v019 keeps creating it
    // as immutable history, and this migration removes it from the live schema.
    // IF EXISTS keeps a replay after a crash between apply() and the stamp safe.
    db.exec(`DROP INDEX IF EXISTS idx_thought_verify_flagged`)
    db.exec(`DROP INDEX IF EXISTS idx_thought_verify_thought`)
    db.exec(`DROP TABLE IF EXISTS thought_verify`)
  }
}
