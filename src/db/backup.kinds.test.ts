import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  type BackupKind,
  backupBeforeRebuild,
  backupDatabase,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_REBUILD_BACKUP_RETENTION,
  pruneBackups
} from './backup'
import { closeDb, initDb } from './init'
import { MIGRATIONS } from './migrations'

const NEWEST = Math.max(...MIGRATIONS.map(m => m.version))
const BASE = 'synaptomind.db'
// `backup.ts` renders `new Date().toISOString()` with `:` and `.` replaced by `-`.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/
// Setup writes must not prune each other, so they are placed far outside any budget.
const KEEP_ALL = 1000
const tmpRoot = mkdtempSync(join(tmpdir(), 'synaptomind-backup-kinds-'))

afterAll(() => {
  closeDb()
  rmSync(tmpRoot, { recursive: true, force: true })
})

function caseDir(name: string): string {
  const dir = join(tmpRoot, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

function seededDb(dir: string): { db: Database; dbPath: string } {
  const dbPath = join(dir, BASE)
  const db = new Database(dbPath)
  db.run('CREATE TABLE t (id INTEGER)')
  db.run('INSERT INTO t VALUES (1)')
  return { db, dbPath }
}

// Distinct mtimes make the prune order the write order instead of the filesystem clock,
// so a case keeps the same eviction set however fast the writer runs.
function setMtime(path: string, order: number): void {
  const when = new Date(2026, 0, 1, 0, 0, order)
  utimesSync(path, when, when)
}

function snapshot(
  db: Database,
  dbPath: string,
  order: number,
  kind: BackupKind,
  retention = KEEP_ALL
): string {
  const path =
    kind === 'rebuild'
      ? backupBeforeRebuild(db, dbPath, NEWEST, retention)
      : backupDatabase(db, dbPath, NEWEST, retention)
  setMtime(path, order)
  return path
}

function snapshotNames(dir: string): string[] {
  return readdirSync(dir)
    .filter(name => name.endsWith('.bak'))
    .sort()
}

function tableNames(dbPath: string): string[] {
  const db = new Database(dbPath)
  try {
    return (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as {
        name: string
      }[]
    ).map(row => row.name)
  } finally {
    db.close()
  }
}

test('a migration snapshot keeps the bare <db>.pre-v<N>.<timestamp>.bak name', () => {
  const dir = caseDir('names-migration')
  const { db, dbPath } = seededDb(dir)

  const path = snapshot(db, dbPath, 1, 'migration')
  db.close()

  const name = basename(path)
  expect(name).not.toContain('.rebuild.')
  expect(name.startsWith(`${BASE}.pre-v${NEWEST}.`)).toBe(true)
  // Everything between the version and the suffix is the timestamp, nothing else.
  expect(name.slice(`${BASE}.pre-v${NEWEST}.`.length, -'.bak'.length)).toMatch(TIMESTAMP)
  expect(existsSync(path)).toBe(true)
})

test('a rebuild snapshot is named <db>.pre-v<N>.rebuild.<timestamp>.bak', () => {
  const dir = caseDir('names-rebuild')
  const { db, dbPath } = seededDb(dir)

  const path = snapshot(db, dbPath, 1, 'rebuild')
  db.close()

  const name = basename(path)
  expect(name.startsWith(`${BASE}.pre-v${NEWEST}.rebuild.`)).toBe(true)
  expect(name.slice(`${BASE}.pre-v${NEWEST}.rebuild.`.length, -'.bak'.length)).toMatch(TIMESTAMP)
  expect(existsSync(path)).toBe(true)
})

test('pruning migration snapshots at their budget leaves every rebuild snapshot alone', () => {
  const dir = caseDir('partition-migration')
  const { db, dbPath } = seededDb(dir)
  // The rebuild snapshot is the oldest file, so a shared budget would evict it first.
  const rebuild = snapshot(db, dbPath, 1, 'rebuild')
  const migrations: string[] = []
  for (let order = 2; order <= DEFAULT_BACKUP_RETENTION + 2; order++) {
    migrations.push(snapshot(db, dbPath, order, 'migration'))
  }
  db.close()

  pruneBackups(dir, BASE, DEFAULT_BACKUP_RETENTION, 'migration')

  // The youngest `retention` migration snapshots stay, and the rebuild file is not in that set.
  expect(snapshotNames(dir)).toEqual(
    [...migrations.slice(1), rebuild].map(path => basename(path)).sort()
  )
})

test('pruning rebuild snapshots at their budget leaves every migration snapshot alone', () => {
  const dir = caseDir('partition-rebuild')
  const { db, dbPath } = seededDb(dir)
  // The migration snapshot is the oldest file, so a shared budget would evict it first.
  const migration = snapshot(db, dbPath, 1, 'migration')
  const rebuilds: string[] = []
  for (let order = 2; order <= DEFAULT_REBUILD_BACKUP_RETENTION + 2; order++) {
    rebuilds.push(snapshot(db, dbPath, order, 'rebuild'))
  }
  db.close()

  pruneBackups(dir, BASE, DEFAULT_REBUILD_BACKUP_RETENTION, 'rebuild')

  expect(snapshotNames(dir)).toEqual(
    [...rebuilds.slice(1), migration].map(path => basename(path)).sort()
  )
})

test('the migration writer keeps exactly its retention snapshots', () => {
  const dir = caseDir('budget-migration')
  const { db, dbPath } = seededDb(dir)

  const written: string[] = []
  for (let order = 1; order <= DEFAULT_BACKUP_RETENTION; order++) {
    written.push(snapshot(db, dbPath, order, 'migration', DEFAULT_BACKUP_RETENTION))
  }
  expect(snapshotNames(dir)).toEqual(written.map(path => basename(path)).sort())

  written.push(
    snapshot(db, dbPath, DEFAULT_BACKUP_RETENTION + 1, 'migration', DEFAULT_BACKUP_RETENTION)
  )
  db.close()

  // retention + 1 snapshots are on disk: the budget evicts the oldest and keeps the rest.
  expect(snapshotNames(dir)).toEqual(
    written
      .slice(1)
      .map(path => basename(path))
      .sort()
  )
})

test('the rebuild writer keeps exactly its retention snapshots', () => {
  const dir = caseDir('budget-rebuild')
  const { db, dbPath } = seededDb(dir)

  const written: string[] = []
  for (let order = 1; order <= DEFAULT_REBUILD_BACKUP_RETENTION; order++) {
    written.push(snapshot(db, dbPath, order, 'rebuild', DEFAULT_REBUILD_BACKUP_RETENTION))
  }
  expect(snapshotNames(dir)).toEqual(written.map(path => basename(path)).sort())

  written.push(
    snapshot(
      db,
      dbPath,
      DEFAULT_REBUILD_BACKUP_RETENTION + 1,
      'rebuild',
      DEFAULT_REBUILD_BACKUP_RETENTION
    )
  )
  db.close()

  expect(snapshotNames(dir)).toEqual(
    written
      .slice(1)
      .map(path => basename(path))
      .sort()
  )
})

test('six rebuild snapshots cannot evict the pre-migration snapshot beside them', () => {
  const dir = caseDir('flip-loop')
  const { db, dbPath } = seededDb(dir)

  const migrationSnapshot = backupDatabase(db, dbPath, NEWEST)
  setMtime(migrationSnapshot, 0)
  // Every flip runs the real writer, so its own default budget decides the survivors.
  for (let flip = 1; flip <= 6; flip++) {
    setMtime(backupBeforeRebuild(db, dbPath, NEWEST), flip)
  }
  db.close()

  const names = snapshotNames(dir)
  expect(existsSync(migrationSnapshot)).toBe(true)
  expect(names).toContain(basename(migrationSnapshot))
  expect(names.filter(name => name.includes('.rebuild.'))).toHaveLength(
    DEFAULT_REBUILD_BACKUP_RETENTION
  )
})

test('one migration snapshot outlives a full rebuild budget plus one more flip', () => {
  const dir = caseDir('recovery')
  const { db, dbPath } = seededDb(dir)

  const migrationSnapshot = backupDatabase(db, dbPath, NEWEST)
  for (let flip = 0; flip <= DEFAULT_REBUILD_BACKUP_RETENTION; flip++) {
    backupBeforeRebuild(db, dbPath, NEWEST)
  }
  db.close()

  const names = readdirSync(dirname(dbPath)).filter(name => name.endsWith('.bak'))
  expect(existsSync(migrationSnapshot)).toBe(true)
  expect(names.filter(name => !name.includes('.rebuild.'))).toEqual([basename(migrationSnapshot)])
  expect(names.filter(name => name.includes('.rebuild.'))).toHaveLength(
    DEFAULT_REBUILD_BACKUP_RETENTION
  )
})

test('a boot with pending migrations takes exactly one snapshot, before the schema moves', () => {
  const dir = caseDir('migration-boot')
  const dbPath = join(dir, BASE)
  // Baseline only: no stamp, no vec_thoughts, no pending_embeddings.
  initDb({ dbPath, runMigrations: false })
  closeDb()
  const baseline = tableNames(dbPath)

  initDb({ dbPath, runMigrations: true })
  closeDb()

  const snapshots = readdirSync(dir).filter(name => name.startsWith(`${BASE}.pre-v`))
  expect(snapshots).toHaveLength(1)
  expect(snapshots[0].startsWith(`${BASE}.pre-v${NEWEST}.`)).toBe(true)
  expect(snapshots[0]).not.toContain('.rebuild.')
  // The snapshot holds the pre-migration schema, so it predates the whole chain.
  expect(tableNames(join(dir, snapshots[0]))).toEqual(baseline)
  expect(baseline).not.toContain('pending_embeddings')
  expect(tableNames(dbPath)).toContain('pending_embeddings')
})
