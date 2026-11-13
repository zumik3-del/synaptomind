import { Database } from 'bun:sqlite'
import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../config'
import { vec0Path } from '../runtime-mode'
import { getDb } from '../context/container'
import { closeDb, initDb } from './init'
import { MIGRATIONS } from './migrations'

const tmpRoot = mkdtempSync(join(tmpdir(), 'synaptomind-v047-'))

afterEach(() => {
  closeDb()
})

afterAll(() => {
  closeDb()
  rmSync(tmpRoot, { recursive: true, force: true })
})

let fixtureCount = 0

const V46 = 46

function buildV46(path: string): void {
  initDb({ dbPath: path, runMigrations: false })
  const db = getDb()
  const stamp = db.prepare(
    `INSERT INTO _meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
  for (const migration of MIGRATIONS) {
    if (migration.version > V46) continue
    db.transaction(() => {
      migration.apply(db, { isMemory: false, dimensions: config.embedder.dimensions })
      stamp.run(String(migration.version))
    })()
  }
  closeDb()
}

function freshPath(label: string): string {
  fixtureCount += 1
  return join(tmpRoot, `${label}-${fixtureCount}.db`)
}

function openRaw<T>(path: string, fn: (db: Database) => T): T {
  const db = new Database(path)
  try {
    // `thoughts` carries vec_thoughts triggers; writing to it needs the extension.
    db.loadExtension(vec0Path())
    return fn(db)
  } finally {
    db.close()
  }
}

function schemaVersion(db: Database): string | undefined {
  const row = db.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined
  return row?.value
}

function indexNames(db: Database): string[] {
  return (db.prepare(`PRAGMA index_list(thoughts)`).all() as Array<{ name: string }>).map(
    i => i.name
  )
}

function columnNames(db: Database): string[] {
  return (db.prepare(`PRAGMA table_info(thoughts)`).all() as Array<{ name: string }>).map(
    c => c.name
  )
}

function flaggedIds(db: Database): string[] {
  return (
    db
      .prepare(`SELECT id FROM thoughts WHERE COALESCE(is_profile, 0) != 0 ORDER BY id`)
      .all() as Array<{ id: string }>
  ).map(r => r.id)
}

function insertProject(db: Database, id: string, name: string): void {
  db.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`).run(
    id,
    name,
    '2020-01-01T00:00:00.000Z'
  )
}

function insertThought(
  db: Database,
  row: {
    id: string
    content: string
    project_id: string | null
    status?: string
    is_profile?: number | null
    updated_at?: string
  }
): void {
  const stamp = row.updated_at ?? '2020-01-01T00:00:00.000Z'
  // Keep an explicit NULL distinct from the omitted (defaulted) case: the
  // migration rewrites truthy values only, so NULL must survive as NULL.
  const flag = row.is_profile === undefined ? 0 : row.is_profile
  db.prepare(`
    INSERT INTO thoughts (id, content, status, source, project_id, content_hash, is_cluster, is_profile, is_protected, is_global, created_at, updated_at, surface_after, archived_at)
    VALUES (?, ?, ?, NULL, ?, NULL, 0, ?, 1, 0, ?, ?, NULL, NULL)
  `).run(row.id, row.content, row.status ?? 'active', row.project_id, flag, stamp, stamp)
}

test('v047 clears the flag on seeded legacy rows and drops the profile index', () => {
  const path = freshPath('seeded')
  buildV46(path)
  openRaw(path, db => {
    // The index is the thing the drop must remove, so pin that it is really
    // there before the upgrade; otherwise the assertion proves nothing.
    expect(indexNames(db)).toContain('idx_thoughts_profile')
    insertProject(db, 'proj-a', 'Project A')
    insertProject(db, 'proj-b', 'Project B')
    insertThought(db, {
      id: 'th-active',
      content: 'persona fact',
      project_id: 'proj-a',
      status: 'active',
      is_profile: 1
    })
    insertThought(db, {
      id: 'th-draft',
      content: 'draft persona',
      project_id: 'proj-b',
      status: 'draft',
      is_profile: 1
    })
    insertThought(db, {
      id: 'th-archived',
      content: 'old persona',
      project_id: 'proj-a',
      status: 'archived',
      is_profile: 1
    })
    insertThought(db, {
      id: 'th-plain',
      content: 'ordinary thought',
      project_id: 'proj-a',
      status: 'active'
    })
    insertThought(db, {
      id: 'th-null',
      content: 'null flag',
      project_id: 'proj-b',
      status: 'active',
      is_profile: null
    })
    expect(flaggedIds(db)).toEqual(['th-active', 'th-archived', 'th-draft'])
  })

  initDb({ dbPath: path, runMigrations: true })
  closeDb()

  openRaw(path, db => {
    expect(schemaVersion(db)).toBe('48')
    expect(flaggedIds(db)).toEqual([])

    expect(
      db
        .prepare(`SELECT id, content, status, is_profile, is_protected FROM thoughts ORDER BY id`)
        .all()
    ).toEqual([
      {
        id: 'th-active',
        content: 'persona fact',
        status: 'active',
        is_profile: 0,
        is_protected: 1
      },
      {
        id: 'th-archived',
        content: 'old persona',
        status: 'archived',
        is_profile: 0,
        is_protected: 1
      },
      { id: 'th-draft', content: 'draft persona', status: 'draft', is_profile: 0, is_protected: 1 },
      { id: 'th-null', content: 'null flag', status: 'active', is_profile: null, is_protected: 1 },
      {
        id: 'th-plain',
        content: 'ordinary thought',
        status: 'active',
        is_profile: 0,
        is_protected: 1
      }
    ])

    expect(indexNames(db)).not.toContain('idx_thoughts_profile')
    // The column stays on purpose (FK parent, forward-only); asserting it here
    // stops a later "tidy-up" from rewriting the table.
    expect(columnNames(db)).toContain('is_profile')
  })
})

test('a fresh v47 database never carries the profile index', () => {
  initDb({ dbPath: ':memory:', runMigrations: true })
  const db = getDb()
  expect(schemaVersion(db)).toBe('48')
  expect(indexNames(db)).not.toContain('idx_thoughts_profile')
  expect(columnNames(db)).toContain('is_profile')
})

test('replaying v047 on an already-upgraded database changes nothing', () => {
  const path = freshPath('replay')
  buildV46(path)
  openRaw(path, db => {
    insertThought(db, { id: 'th-a', content: 'persona a', project_id: null, is_profile: 1 })
    insertThought(db, { id: 'th-b', content: 'plain b', project_id: null })
  })

  initDb({ dbPath: path, runMigrations: true })
  closeDb()

  const snapshot = (): unknown =>
    openRaw(path, db => ({
      version: schemaVersion(db),
      indexes: indexNames(db).sort(),
      thoughts: db
        .prepare(`SELECT id, content, status, is_profile, updated_at FROM thoughts ORDER BY id`)
        .all()
    }))

  const upgraded = snapshot()
  expect((upgraded as { version: string }).version).toBe('48')

  initDb({ dbPath: path, runMigrations: true })
  closeDb()
  expect(snapshot()).toEqual(upgraded)

  openRaw(path, db => {
    db.prepare(`UPDATE _meta SET value = '46' WHERE key = 'schema_version'`).run()
  })
  initDb({ dbPath: path, runMigrations: true })
  closeDb()

  expect(snapshot()).toEqual(upgraded)
})
