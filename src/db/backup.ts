import type { Database } from 'bun:sqlite'
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** How many pre-migration backups are retained alongside the database. */
export const DEFAULT_BACKUP_RETENTION = 5

/**
 * Take a consistent, WAL-safe snapshot of `db` into a file next to `dbPath`
 * before a schema migration runs. Uses `VACUUM INTO`, which produces a
 * complete, checkpointed copy regardless of the active journal mode.
 *
 * The backup is named `{db basename}.pre-v{targetVersion}.{timestamp}.bak` so
 * the migration it precedes and the moment it was taken are both recoverable
 * from the filename alone.
 *
 * Throws when the snapshot cannot be written — a failed backup must never be
 * silently followed by an irreversible migration.
 */
export function backupDatabase(
  db: Database,
  dbPath: string,
  targetVersion: number,
  retention: number = DEFAULT_BACKUP_RETENTION
): string {
  if (dbPath === ':memory:') {
    throw new Error('Cannot back up an in-memory database')
  }
  const dir = dirname(dbPath)
  const base = basename(dbPath)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  let backupPath = join(dir, `${base}.pre-v${targetVersion}.${timestamp}.bak`)
  let counter = 0
  while (existsSync(backupPath)) {
    counter++
    backupPath = join(dir, `${base}.pre-v${targetVersion}.${timestamp}-${counter}.bak`)
  }

  try {
    db.run('VACUUM INTO ?', [backupPath])
  } catch (err) {
    try {
      unlinkSync(backupPath)
    } catch {
      // Best effort: the partial file (if any) is not worth failing over.
    }
    throw new Error(
      `Database backup failed before applying migrations (target v${targetVersion}): ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }

  pruneBackups(dir, base, retention)
  return backupPath
}

/**
 * Keep only the `retention` most recent pre-migration backups for `base`,
 * deleting the rest. A pruning failure is logged but does not abort the
 * migration — the backup itself has already succeeded.
 */
export function pruneBackups(dir: string, base: string, retention: number): void {
  if (retention <= 0) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^${escaped}\\.pre-v\\d+\\..*\\.bak$`)
  const backups = entries
    .filter(name => pattern.test(name))
    .map(name => {
      const path = join(dir, name)
      let mtime = 0
      try {
        mtime = statSync(path).mtimeMs
      } catch {
        mtime = 0
      }
      return { path, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime)

  for (const backup of backups.slice(retention)) {
    try {
      unlinkSync(backup.path)
    } catch (err) {
      console.error('[db] backup prune failed:', err)
    }
  }
}