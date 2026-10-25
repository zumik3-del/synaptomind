import type { Database } from 'bun:sqlite'
import { ThoughtContentConflictError } from './errors'

/**
 * The content-dedupe write guard (v046, unique index
 * `idx_thoughts_content_dedupe`): two live (draft/active) thoughts in one
 * project cannot share content.
 *
 * `createThought` satisfies the invariant through `ON CONFLICT ... DO NOTHING`
 * (it returns the existing thought); an edit has no such escape hatch, so
 * `updateThought` checks here and maps the SQLite fault below.
 */
export function assertNoLiveContentConflict(
  db: Database,
  id: string,
  contentHash: string | null,
  projectId: string,
  status: string
): void {
  if (!contentHash || (status !== 'draft' && status !== 'active')) return
  const clash = db
    .prepare(
      `SELECT id FROM thoughts WHERE content_hash = ? AND project_id IS ? AND status IN ('draft', 'active') AND id <> ? LIMIT 1`
    )
    .get(contentHash, projectId, id) as { id: string } | undefined
  if (clash) throw new ThoughtContentConflictError(clash.id)
}

/**
 * The SQLite half of the same invariant: a write that slipped past the
 * pre-check (a concurrent writer claimed the content in between) still fails
 * with `SQLITE_CONSTRAINT_UNIQUE` on (content_hash, project_id). Translate that
 * one case into the domain conflict — never any other constraint fault.
 */
export function isContentDedupeViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as Error & { code?: unknown }).code
  return code === 'SQLITE_CONSTRAINT_UNIQUE' && err.message.includes('thoughts.content_hash')
}
