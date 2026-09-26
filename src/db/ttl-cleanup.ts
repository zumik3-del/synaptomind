import type { Database } from 'bun:sqlite'

/** Ids of archived, unprotected thoughts whose archived_at is older than the cutoff. */
export function findExpiredArchivedThoughtIds(db: Database, cutoff: string): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM thoughts WHERE status = 'archived' AND archived_at IS NOT NULL AND archived_at < ? AND (is_protected IS NULL OR is_protected = 0)`
    )
    .all(cutoff) as { id: string }[]
  return rows.map(r => r.id)
}