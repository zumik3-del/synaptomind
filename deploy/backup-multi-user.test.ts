import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { guardRealStateDir, installCleanup, isolatedEnv, mkTempTree } from './tmp-fixtures'

// Task #2299: the operator path that matters after a multi-user cutover is not
// one database but N. The single-DB suites already prove the WAL-safe snapshot
// and the fail-closed abort; what is unpinned here is that `backup_databases`
// enumerates EVERY user database from the custom config and that each snapshot
// restores on its own, without reading a sibling's rows.
//
// The fixtures are real SQLite files written by bun:sqlite, and the writer
// handles stay OPEN across the backup: that is what puts the committed rows in
// the WAL instead of the main file, so a plain `cp` would lose them. The backup
// itself runs the installed script with a stubbed systemctl (never the host's)
// and the host's real sqlite3, inside a tree this process owns.

installCleanup()
guardRealStateDir()

const LIB = join(import.meta.dir, 'lib', 'common.sh')

function quote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`
}

function makeStubs(root: string): string {
  const stubs = join(root, 'stubs')
  mkdirSync(stubs, { recursive: true })
  writeFileSync(
    join(stubs, 'systemctl'),
    '#!/usr/bin/env bash\ncase "$*" in\n  *"is-active"*) exit 3 ;;\n  *) printf "\\n"; exit 0 ;;\nesac\n'
  )
  chmodSync(join(stubs, 'systemctl'), 0o755)
  writeFileSync(join(stubs, 'sqlite3'), '#!/usr/bin/env bash\nexec /usr/bin/sqlite3 "$@"\n')
  chmodSync(join(stubs, 'sqlite3'), 0o755)
  return stubs
}

function runCommon(root: string, script: string, envExtra: Record<string, string> = {}) {
  const env = isolatedEnv(root, {
    PATH: `${join(root, 'stubs')}:${process.env.PATH ?? ''}`,
    APP_NAME: 'synaptomind',
    ...envExtra
  })
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', env, timeout: 60_000 })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

function sqlite(db: string, sql: string): string {
  const r = spawnSync('sqlite3', [db, sql], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`sqlite3 failed for ${db}: ${r.stderr}`)
  return r.stdout.trim()
}

interface SeededDb {
  id: string
  path: string
  marker: string
  writer: Database
}

/** Create a WAL-mode DB and keep the writer open so the row stays in the WAL. */
function seedWalDb(path: string, marker: string, id: string): SeededDb {
  mkdirSync(dirname(path), { recursive: true })
  const writer = new Database(path)
  writer.query('PRAGMA journal_mode = WAL').get()
  writer.run('CREATE TABLE private (x TEXT)')
  writer.run('INSERT INTO private (x) VALUES (?)', [marker])
  return { id, path, marker, writer }
}

function backupPaths(stdout: string): string[] {
  const m = /BACKUPS=(.*)/.exec(stdout)
  expect(m).not.toBeNull()
  return m![1].trim().split(/\s+/).filter(Boolean)
}

describe('deploy backup (task #2299) - all user databases', () => {
  test('snapshots every configured user DB in WAL state and restores each in isolation', () => {
    const root = mkTempTree('synapto-bk-users-')
    const app = join(root, 'app')
    mkdirSync(join(app, 'data'), { recursive: true })

    const dbs: SeededDb[] = [
      seedWalDb(join(app, 'data', 'main.db'), 'main-private-marker', 'main'),
      // User DBs live OUTSIDE the install/data tree on purpose: the deploy
      // resolver's discovery net only walks data dirs, so a snapshot of these
      // can only come from the custom config's `users[].dbPath`.
      seedWalDb(join(root, 'volumes', 'alice', 'alice.db'), 'alice-private-marker', 'alice'),
      seedWalDb(join(root, 'volumes', 'bob', 'bob.db'), 'bob-private-marker', 'bob')
    ]
    try {
      // The open writer keeps the row in the WAL: the snapshot has to come from
      // SQLite, not from a byte copy of the main file.
      for (const db of dbs) {
        expect(existsSync(`${db.path}-wal`), `expected a WAL beside ${db.path}`).toBe(true)
        expect(sqlite(db.path, 'SELECT x FROM private;')).toBe(db.marker)
      }

      const cfg = join(app, 'config.json')
      writeFileSync(
        cfg,
        JSON.stringify({
          db: { path: './data/main.db' },
          users: [
            { id: 'alice', dbPath: dbs[1].path, tokenSha256: 'a'.repeat(64) },
            { id: 'bob', dbPath: dbs[2].path, tokenSha256: 'b'.repeat(64) }
          ]
        })
      )

      makeStubs(root)
      const script = [
        'APP_NAME=synaptomind',
        `INSTALL_DIR=${quote(app)}`,
        `export SYNAPTOMIND_CONFIG=${quote(cfg)}`,
        'export BACKUP_KEEP=5',
        `. ${quote(LIB)}`,
        'backup_databases',
        'RC=$?',
        'echo "RC=$RC"',
        'echo "BACKUPS=${DB_BACKUPS[*]}"'
      ].join('\n')

      const res = runCommon(root, script, { INSTALL_DIR: app, SYNAPTOMIND_CONFIG: cfg })
      expect(res.stderr).not.toContain('ERROR')
      const backups = backupPaths(res.stdout)

      // One snapshot per configured DB, never one shared or one skipped.
      expect(backups).toHaveLength(3)
      const byId = new Map<string, string>()
      for (const db of dbs) {
        const match = backups.filter(b => b.includes(`/${db.id === 'main' ? 'main' : db.id}.db.`))
        expect(match, `no snapshot for ${db.id}`).toHaveLength(1)
        byId.set(db.id, match[0])
      }

      for (const db of dbs) {
        const backup = byId.get(db.id)!
        // Snapshot is self-contained: no WAL/SHM sidecars to forget on restore.
        expect(existsSync(`${backup}-wal`)).toBe(false)
        expect(existsSync(`${backup}-shm`)).toBe(false)
        expect(sqlite(backup, 'PRAGMA quick_check;')).toBe('ok')
        expect(sqlite(backup, 'PRAGMA user_version;')).toBe(sqlite(db.path, 'PRAGMA user_version;'))
        // Only this user's row, captured from the WAL.
        expect(sqlite(backup, 'SELECT count(*) FROM private;')).toBe('1')
        expect(sqlite(backup, 'SELECT x FROM private;')).toBe(db.marker)
      }

      // Restore each snapshot into its own directory. A restore is isolated:
      // the restored copy carries that user's rows and no sibling's marker.
      const restoreRoot = join(root, 'restore')
      for (const db of dbs) {
        const dir = join(restoreRoot, db.id)
        mkdirSync(dir, { recursive: true })
        const restored = join(dir, 'restored.db')
        copyFileSync(byId.get(db.id)!, restored)
        expect(sqlite(restored, 'PRAGMA quick_check;')).toBe('ok')
        expect(sqlite(restored, 'SELECT x FROM private;')).toBe(db.marker)
        for (const other of dbs) {
          if (other.id === db.id) continue
          expect(
            sqlite(restored, `SELECT count(*) FROM private WHERE x = '${other.marker}';`)
          ).toBe('0')
        }
      }

      // Snapshot isolation: rows written after the backup must not appear in
      // it, and must not disturb any sibling's snapshot.
      for (const db of dbs)
        db.writer.run('INSERT INTO private (x) VALUES (?)', [`${db.marker}-after`])
      for (const db of dbs) {
        expect(sqlite(byId.get(db.id)!, 'SELECT count(*) FROM private;')).toBe('1')
        expect(sqlite(db.path, 'SELECT count(*) FROM private;')).toBe('2')
      }
    } finally {
      for (const db of dbs) db.writer.close()
    }
  })
})
