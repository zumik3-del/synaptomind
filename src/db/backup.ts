import type { Database } from 'bun:sqlite'
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// The two kinds never share an eviction budget.
export type BackupKind = 'migration' | 'rebuild'

export const DEFAULT_BACKUP_RETENTION = 5
export const DEFAULT_REBUILD_BACKUP_RETENTION = 2

const REBUILD_LABEL = 'rebuild'

// Throws when the snapshot cannot be written: a failed backup must never be followed by an
// irreversible migration.
export function backupDatabase(
  db: Database,
  dbPath: string,
  targetVersion: number,
  retention: number = DEFAULT_BACKUP_RETENTION
): string {
  return writeSnapshot(db, dbPath, targetVersion, retention, 'migration')
}

// A dimension rebuild is not a migration, so its snapshot carries its own name segment and its own
// retention budget: a config flip loop must never evict a pre-migration backup.
export function backupBeforeRebuild(
  db: Database,
  dbPath: string,
  version: number,
  retention: number = DEFAULT_REBUILD_BACKUP_RETENTION
): string {
  return writeSnapshot(db, dbPath, version, retention, 'rebuild')
}

function writeSnapshot(
  db: Database,
  dbPath: string,
  version: number,
  retention: number,
  kind: BackupKind
): string {
  if (dbPath === ':memory:') {
    throw new Error('Cannot back up an in-memory database')
  }
  const dir = dirname(dbPath)
  const base = basename(dbPath)
  const prefix = `${base}.pre-v${version}${kind === 'rebuild' ? `.${REBUILD_LABEL}` : ''}`
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  let backupPath = join(dir, `${prefix}.${timestamp}.bak`)
  let counter = 0
  while (existsSync(backupPath)) {
    counter++
    backupPath = join(dir, `${prefix}.${timestamp}-${counter}.bak`)
  }

  try {
    db.run('VACUUM INTO ?', [backupPath])
  } catch (err) {
    try {
      unlinkSync(backupPath)
    } catch {}
    const step = kind === 'rebuild' ? 'rebuilding the vector index' : 'applying migrations'
    const versionLabel =
      kind === 'rebuild'
        ? `the schema is at v${version}`
        : `this boot was moving the schema to v${version}`
    throw new Error(
      `Database backup failed before ${step} (${versionLabel}): ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }

  pruneBackups(dir, base, retention, kind)
  return backupPath
}

function snapshotPattern(base: string, kind: BackupKind): RegExp {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // A migration snapshot continues straight into the ISO timestamp; only a rebuild snapshot has the
  // label segment there, so neither pattern can ever match the other kind's files.
  const kindSegment = kind === 'rebuild' ? `${REBUILD_LABEL}\\.` : '\\d{4}-'
  return new RegExp(`^${escaped}\\.pre-v\\d+\\.${kindSegment}.*\\.bak$`)
}

export function pruneBackups(
  dir: string,
  base: string,
  retention: number,
  kind: BackupKind = 'migration'
): void {
  if (retention <= 0) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  const pattern = snapshotPattern(base, kind)
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
