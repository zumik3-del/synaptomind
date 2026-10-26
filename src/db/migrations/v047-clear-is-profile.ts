import type { Database } from 'bun:sqlite'

/**
 * v047 — the profile surface is retired (issue #1939): the flag is cleared on
 * every legacy row and its partial index is dropped.
 *
 * The column itself is kept. `thoughts` is the foreign-key parent of `edges`,
 * `thought_tags`, `thought_importance`, `pending_embeddings`, `vec_thoughts`
 * and `primers`, and `ALTER TABLE ... DROP COLUMN` rewrites the table; clearing
 * the values is the forward-only fix that needs no rebuild, and the application
 * no longer reads or writes the column (`Thought` has no such field).
 *
 * Idempotent: the index drop is guarded and the UPDATE matches nothing once
 * every row reads 0.
 */
export default {
  version: 47,
  apply(db: Database): void {
    db.exec(`DROP INDEX IF EXISTS idx_thoughts_profile`)
    db.exec(`UPDATE thoughts SET is_profile = 0 WHERE is_profile IS NOT NULL AND is_profile != 0`)
  }
}
