import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { guardRealStateDir, installCleanup, isolatedEnv, mkTempTree } from './tmp-fixtures'

installCleanup()
guardRealStateDir()

const LIB = join(import.meta.dir, 'lib', 'common.sh')
const HOOK = join(import.meta.dir, 'hooks', 'pre-update')

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
  return stubs
}

function makeSqliteStub(root: string, fail: boolean): string {
  const stubs = join(root, 'stubs')
  mkdirSync(stubs, { recursive: true })
  const body = fail
    ? '#!/usr/bin/env bash\necho "stub: sqlite3 failed" >&2\nexit 1\n'
    : '#!/usr/bin/env bash\nexec /usr/bin/sqlite3 "$@"\n'
  writeFileSync(join(stubs, 'sqlite3'), body)
  chmodSync(join(stubs, 'sqlite3'), 0o755)
  return stubs
}

function runCommon(
  root: string,
  script: string,
  envExtra: Record<string, string> = {}
): { status: number | null; stdout: string; stderr: string } {
  const stubs = (envExtra.__stubs as string) ?? makeStubs(root)
  const env = isolatedEnv(root, {
    PATH: `${stubs}:${process.env.PATH ?? ''}`,
    APP_NAME: 'synaptomind',
    ...envExtra
  })
  delete (env as Record<string, unknown>).__stubs
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', env, timeout: 60_000 })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

function sqlite(db: string, sql: string): void {
  const r = spawnSync('sqlite3', [db, sql], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`sqlite3 failed: ${r.stderr}`)
}

describe('deploy backup (task #2297) - effective paths', () => {
  test('resolves main + per-user db paths from config and env', () => {
    const root = mkTempTree('synapto-bk-')
    const app = join(root, 'app')
    mkdirSync(join(app, 'data'), { recursive: true })
    const dbPath = join(app, 'data', 'main.db')
    const userDb = join(app, 'data', 'alice.db')
    sqlite(dbPath, 'CREATE TABLE t(x); INSERT INTO t VALUES(1);')
    sqlite(userDb, 'CREATE TABLE t(x); INSERT INTO t VALUES(2);')
    const cfg = join(app, 'config.json')
    writeFileSync(
      cfg,
      JSON.stringify({
        db: { path: './data/main.db' },
        users: [{ id: 'alice', dbPath: userDb, tokenSha256: '0'.repeat(64) }]
      })
    )

    const stubs = makeStubs(root)
    const script = [
      'APP_NAME=synaptomind',
      `INSTALL_DIR=${quote(app)}`,
      `export SYNAPTOMIND_CONFIG=${quote(cfg)}`,
      `. ${quote(LIB)}`,
      'service_unit_context',
      'service_environment',
      'effective_db_paths'
    ].join('\n')
    const res = runCommon(root, script, {
      __stubs: stubs,
      SYNAPTOMIND_CONFIG: cfg,
      INSTALL_DIR: app
    } as Record<string, string>)
    expect(res.stdout).toContain(dbPath)
    expect(res.stdout).toContain(userDb)
  })

  test('JSON escapes and whitespace are decoded', () => {
    const root = mkTempTree('synapto-bk-')
    const app = join(root, 'app')
    mkdirSync(join(app, 'data'), { recursive: true })
    const dbName = 'my db é.db'
    const dbPath = join(app, 'data', dbName)
    const userDb = join(app, 'data', 'user ☃.db')
    sqlite(dbPath, 'CREATE TABLE t(x);')
    sqlite(userDb, 'CREATE TABLE t(x);')
    const cfg = join(app, 'config.json')
    writeFileSync(
      cfg,
      JSON.stringify({
        db: { path: `./data/${dbName}` },
        users: [{ id: 'u', dbPath: userDb, tokenSha256: '0'.repeat(64) }]
      })
    )

    const stubs = makeStubs(root)
    const script = [
      'APP_NAME=synaptomind',
      `INSTALL_DIR=${quote(app)}`,
      `export SYNAPTOMIND_CONFIG=${quote(cfg)}`,
      `. ${quote(LIB)}`,
      'service_unit_context',
      'service_environment',
      'effective_db_paths'
    ].join('\n')
    const res = runCommon(root, script, {
      __stubs: stubs,
      SYNAPTOMIND_CONFIG: cfg,
      INSTALL_DIR: app
    } as Record<string, string>)
    expect(res.stdout).toContain(dbPath)
    expect(res.stdout).toContain(userDb)
  })

  test('unparseable config aborts resolution', () => {
    const root = mkTempTree('synapto-bk-')
    const app = join(root, 'app')
    mkdirSync(join(app, 'data'), { recursive: true })
    const cfg = join(app, 'config.json')
    writeFileSync(cfg, '{ this is not json }')
    const stubs = makeStubs(root)
    const script = [
      'APP_NAME=synaptomind',
      `INSTALL_DIR=${quote(app)}`,
      `export SYNAPTOMIND_CONFIG=${quote(cfg)}`,
      `. ${quote(LIB)}`,
      'service_unit_context',
      'service_environment',
      'effective_db_paths; rc=$?',
      'echo "RC=$rc"',
      'exit $rc'
    ].join('\n')
    const res = runCommon(root, script, {
      __stubs: stubs,
      SYNAPTOMIND_CONFIG: cfg,
      INSTALL_DIR: app
    } as Record<string, string>)
    // effective_db_paths returns non-zero on parse failure
    expect(res.status).not.toBe(0)
  })

  test('SYNAPTOMIND_DB_PATH override is included and deduped', () => {
    const root = mkTempTree('synapto-bk-')
    const app = join(root, 'app')
    mkdirSync(join(app, 'data'), { recursive: true })
    const dbPath = join(app, 'data', 'main.db')
    sqlite(dbPath, 'CREATE TABLE t(x);')
    const cfg = join(app, 'config.json')
    writeFileSync(cfg, JSON.stringify({ db: { path: './data/main.db' }, users: [] }))
    const linkPath = join(app, 'data', 'link.db')
    try {
      const { rmSync } = require('node:fs')
      rmSync(linkPath)
    } catch {}
    const { symlinkSync } = require('node:fs')
    symlinkSync(dbPath, linkPath)

    const stubs = makeStubs(root)
    const script = [
      'APP_NAME=synaptomind',
      `INSTALL_DIR=${quote(app)}`,
      `export SYNAPTOMIND_CONFIG=${quote(cfg)}`,
      `export SYNAPTOMIND_DB_PATH=${quote('./data/main.db')}`,
      `. ${quote(LIB)}`,
      'service_unit_context',
      'service_environment',
      'effective_db_paths'
    ].join('\n')
    const res = runCommon(root, script, {
      __stubs: stubs,
      SYNAPTOMIND_CONFIG: cfg,
      SYNAPTOMIND_DB_PATH: './data/main.db',
      INSTALL_DIR: app
    } as Record<string, string>)
    const occurrences = res.stdout.split('\n').filter(l => l.trim() === dbPath).length
    expect(occurrences).toBe(1)
  })
})

describe('deploy backup (task #2297) - backup/restore', () => {
  test('backup creates WAL-safe snapshot and closes handles', () => {
    const root = mkTempTree('synapto-bk-')
    const app = join(root, 'app')
    mkdirSync(join(app, 'data'), { recursive: true })
    const dbPath = join(app, 'data', 'main.db')
    sqlite(dbPath, 'PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES(42);')
    const cfg = join(app, 'config.json')
    writeFileSync(cfg, JSON.stringify({ db: { path: './data/main.db' }, users: [] }))

    const stubs = makeStubs(root)
    makeSqliteStub(root, false)
    const script = [
      'APP_NAME=synaptomind',
      `INSTALL_DIR=${quote(app)}`,
      `export SYNAPTOMIND_CONFIG=${quote(cfg)}`,
      'export BACKUP_KEEP=5',
      `. ${quote(LIB)}`,
      'service_unit_context',
      'service_environment',
      'backup_databases',
      'echo "RC=$?"',
      'echo "BACKUPS=${DB_BACKUPS[*]}"'
    ].join('\n')
    const res = runCommon(root, script, {
      __stubs: stubs,
      SYNAPTOMIND_CONFIG: cfg,
      INSTALL_DIR: app
    } as Record<string, string>)
    expect(res.stderr).not.toContain('ERROR')
    const m = /BACKUPS=(.*)/.exec(res.stdout)
    expect(m).not.toBeNull()
    const backup = m![1].trim().split(' ')[0]
    expect(existsSync(backup)).toBe(true)
    expect(existsSync(backup + '-wal')).toBe(false)
    expect(existsSync(backup + '-shm')).toBe(false)
    const q = spawnSync('sqlite3', [backup, 'SELECT x FROM t;'], { encoding: 'utf8' })
    expect(q.stdout.trim()).toBe('42')
    const qc = spawnSync('sqlite3', [backup, 'PRAGMA quick_check;'], { encoding: 'utf8' })
    expect(qc.stdout.trim()).toBe('ok')
    sqlite(dbPath, 'INSERT INTO t VALUES (7);')
    const c = spawnSync('sqlite3', [dbPath, 'SELECT count(*) FROM t;'], { encoding: 'utf8' })
    expect(c.stdout.trim()).toBe('2')
  })

  test('restore snapshot preserves contents', () => {
    const root = mkTempTree('synapto-bk-')
    const app = join(root, 'app')
    mkdirSync(join(app, 'data'), { recursive: true })
    const dbPath = join(app, 'data', 'main.db')
    sqlite(dbPath, 'CREATE TABLE t(x); INSERT INTO t VALUES(99);')
    const cfg = join(app, 'config.json')
    writeFileSync(cfg, JSON.stringify({ db: { path: './data/main.db' }, users: [] }))

    const stubs = makeStubs(root)
    makeSqliteStub(root, false)
    const script = [
      'APP_NAME=synaptomind',
      `INSTALL_DIR=${quote(app)}`,
      `export SYNAPTOMIND_CONFIG=${quote(cfg)}`,
      `. ${quote(LIB)}`,
      'service_unit_context',
      'service_environment',
      'backup_databases >/dev/null 2>&1',
      'printf \'%s\\n\' "${DB_BACKUPS[0]}"'
    ].join('\n')
    const res = runCommon(root, script, {
      __stubs: stubs,
      SYNAPTOMIND_CONFIG: cfg,
      INSTALL_DIR: app
    } as Record<string, string>)
    const backup = res.stdout.trim().split('\n').pop()!.trim()
    expect(existsSync(backup)).toBe(true)
    const restored = join(app, 'data', 'restored.db')
    const cp = spawnSync('cp', [backup, restored], { encoding: 'utf8' })
    expect(cp.status).toBe(0)
    const q = spawnSync('sqlite3', [restored, 'SELECT x FROM t;'], { encoding: 'utf8' })
    expect(q.stdout.trim()).toBe('99')
  })
})

describe('deploy backup (task #2297) - failure abort', () => {
  test('backup_databases returns non-zero when sqlite3 fails', () => {
    const root = mkTempTree('synapto-bk-')
    const app = join(root, 'app')
    mkdirSync(join(app, 'data'), { recursive: true })
    const dbPath = join(app, 'data', 'main.db')
    sqlite(dbPath, 'CREATE TABLE t(x);')
    const cfg = join(app, 'config.json')
    writeFileSync(cfg, JSON.stringify({ db: { path: './data/main.db' }, users: [] }))

    const stubs = makeStubs(root)
    makeSqliteStub(root, true)
    const script = [
      'APP_NAME=synaptomind',
      `INSTALL_DIR=${quote(app)}`,
      `export SYNAPTOMIND_CONFIG=${quote(cfg)}`,
      `. ${quote(LIB)}`,
      'service_unit_context',
      'service_environment',
      'if backup_databases; then echo "RC=0"; else echo "RC=$?"; fi'
    ].join('\n')
    const res = runCommon(root, script, {
      __stubs: stubs,
      SYNAPTOMIND_CONFIG: cfg,
      INSTALL_DIR: app
    } as Record<string, string>)
    // error() exits the shell, so the if/else echo never runs; non-zero status is the abort signal.
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('ERROR')
  })
})

describe('deploy backup (task #2297) - retention', () => {
  test('prunes old backups beyond BACKUP_KEEP', () => {
    const root = mkTempTree('synapto-bk-')
    const app = join(root, 'app')
    mkdirSync(join(app, 'data'), { recursive: true })
    const dbPath = join(app, 'data', 'main.db')
    sqlite(dbPath, 'CREATE TABLE t(x);')
    const cfg = join(app, 'config.json')
    writeFileSync(cfg, JSON.stringify({ db: { path: './data/main.db' }, users: [] }))

    const bdir = dbPath + '.backup'
    mkdirSync(bdir, { recursive: true })
    for (let i = 1; i <= 3; i++) {
      writeFileSync(join(bdir, `main.db.2026010${i}-000000-1.bak`), 'x')
    }

    const stubs = makeStubs(root)
    makeSqliteStub(root, false)
    const script = [
      'APP_NAME=synaptomind',
      `INSTALL_DIR=${quote(app)}`,
      `export SYNAPTOMIND_CONFIG=${quote(cfg)}`,
      'export BACKUP_KEEP=2',
      `. ${quote(LIB)}`,
      'service_unit_context',
      'service_environment',
      'backup_databases >/dev/null 2>&1 || true'
    ].join('\n')
    runCommon(root, script, {
      __stubs: stubs,
      SYNAPTOMIND_CONFIG: cfg,
      INSTALL_DIR: app,
      BACKUP_KEEP: '2'
    } as Record<string, string>)
    const remaining = readdirSync(bdir).filter(n => n.endsWith('.bak'))
    expect(remaining.length).toBeLessThanOrEqual(2)
  })
})

describe('deploy backup (task #2297) - first-update', () => {
  test('pre-update hook skips when APP_BACKUP_ALREADY_DONE=1', () => {
    const root = mkTempTree('synapto-bk-')
    const env = isolatedEnv(root, {
      RUN_DIR: join(root, 'run'),
      APP_NAME: 'synaptomind',
      INSTALL_DIR: join(root, 'app'),
      APP_BACKUP_ALREADY_DONE: '1',
      PATH: `${process.env.PATH ?? ''}`
    })
    const res = spawnSync('bash', [HOOK], { encoding: 'utf8', env, timeout: 30_000 })
    expect(res.stdout + res.stderr).toContain('built-in backup already performed')
  })
})
