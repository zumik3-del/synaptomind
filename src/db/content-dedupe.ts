import type { Database } from 'bun:sqlite'
import { ThoughtContentConflictError } from './errors'

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

export function isContentDedupeViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as Error & { code?: unknown }).code
  return code === 'SQLITE_CONSTRAINT_UNIQUE' && err.message.includes('thoughts.content_hash')
}
