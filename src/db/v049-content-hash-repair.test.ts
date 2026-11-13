import { Database } from 'bun:sqlite'
import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../config'
import { getDb } from '../context/container'
import { vec0Path } from '../runtime-mode'
import { computeContentHash } from '../utils'
import { closeDb, initDb } from './init'
import { MIGRATIONS } from './migrations'

const V48 = 48
const OLDER = '2026-01-01T00:00:00.000Z'
const NEWER = '2026-01-02T00:00:00.000Z'

const tmpRoot = mkdtempSync(join(tmpdir(), 'synaptomind-v049-'))

afterEach(() => {
  closeDb()
})

afterAll(() => {
  closeDb()
  rmSync(tmpRoot, { recursive: true, force: true })
})

let fixtureCount = 0

function freshPath(label: string): string {
  fixtureCount += 1
  return join(tmpRoot, `${label}-${fixtureCount}.db`)
}

/** A v048 database, built by the migrations themselves, so v049 is the only step left to run. */
function buildV48(path: string): void {
  initDb({ dbPath: path, runMigrations: false })
  const db = getDb()
  const stamp = db.prepare(
    `INSERT INTO _meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
  for (const migration of MIGRATIONS) {
    if (migration.version > V48) continue
    db.transaction(() => {
      migration.apply(db, { isMemory: false, dimensions: config.embedder.dimensions })
      stamp.run(String(migration.version))
    })()
  }
  closeDb()
}

function openRaw<T>(path: string, fn: (db: Database) => T): T {
  const db = new Database(path)
  try {
    db.loadExtension(vec0Path())
    return fn(db)
  } finally {
    db.close()
  }
}

function upgrade(path: string): void {
  initDb({ dbPath: path, runMigrations: true })
  closeDb()
}

function schemaVersion(db: Database): string | undefined {
  const row = db.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined
  return row?.value
}

interface ThoughtRow {
  id: string
  content: string
  status: string
  project_id: string
  content_hash: string | null
  archived_at: string | null
  updated_at: string
  is_protected: number
}

/** A row whose stored hash belongs to another project — the state v049 has to repair. */
function seedStale(
  db: Database,
  row: { id: string; content: string; project_id: string; created_at?: string; status?: string }
): void {
  seedRow(db, row, computeContentHash(row.content, `deleted-${row.project_id}`))
}

/** A row whose stored hash already matches `(content, project_id)`. */
function seedLive(
  db: Database,
  row: { id: string; content: string; project_id: string; created_at?: string; status?: string }
): void {
  seedRow(db, row, computeContentHash(row.content, row.project_id))
}

function seedRow(
  db: Database,
  row: { id: string; content: string; project_id: string; created_at?: string; status?: string },
  contentHash: string
): void {
  const createdAt = row.created_at ?? OLDER
  db.prepare(`
    INSERT INTO thoughts (id, content, status, source, project_id, content_hash, created_at, updated_at)
    VALUES (?, ?, ?, 'test', ?, ?, ?, ?)
  `).run(
    row.id,
    row.content,
    row.status ?? 'active',
    row.project_id,
    contentHash,
    createdAt,
    createdAt
  )
}

function thoughtRows(db: Database): ThoughtRow[] {
  return db
    .prepare(
      `SELECT id, content, status, project_id, content_hash, archived_at, updated_at, is_protected
       FROM thoughts ORDER BY id`
    )
    .all() as ThoughtRow[]
}

function liveIds(db: Database, content: string, projectId: string): string[] {
  return (
    db
      .prepare(
        `SELECT id FROM thoughts
         WHERE content = ? AND project_id = ? AND status IN ('draft', 'active')
         ORDER BY created_at ASC, id ASC`
      )
      .all(content, projectId) as { id: string }[]
  ).map(row => row.id)
}

function staleIds(db: Database): string[] {
  return thoughtRows(db)
    .filter(
      thought => thought.content_hash !== computeContentHash(thought.content, thought.project_id)
    )
    .map(thought => thought.id)
}

test('v049 is registered after v048', () => {
  expect(MIGRATIONS.at(-1)?.version).toBe(49)
})

test('upgrading a v048 database recomputes every stale hash', () => {
  const path = freshPath('repair')
  buildV48(path)
  openRaw(path, db => {
    seedStale(db, { id: 'th-active', content: 'alpha', project_id: 'proj-a' })
    seedStale(db, { id: 'th-draft', content: 'beta', project_id: 'proj-a', status: 'draft' })
    seedStale(db, {
      id: 'th-archived',
      content: 'gamma',
      project_id: 'proj-b',
      created_at: NEWER,
      status: 'archived'
    })
    seedLive(db, { id: 'th-healthy', content: 'delta', project_id: 'proj-b', created_at: NEWER })
    expect(staleIds(db)).toEqual(['th-active', 'th-archived', 'th-draft'])
  })

  upgrade(path)

  openRaw(path, db => {
    expect(staleIds(db)).toEqual([])
    expect(schemaVersion(db)).toBe('49')
    const byId = new Map(thoughtRows(db).map(thought => [thought.id, thought]))
    expect(byId.get('th-active')?.content_hash).toBe(computeContentHash('alpha', 'proj-a'))
    expect(byId.get('th-draft')?.content_hash).toBe(computeContentHash('beta', 'proj-a'))
    expect(byId.get('th-archived')?.content_hash).toBe(computeContentHash('gamma', 'proj-b'))
    expect(byId.get('th-healthy')?.content_hash).toBe(computeContentHash('delta', 'proj-b'))
    expect(byId.get('th-active')?.status).toBe('active')
    expect(byId.get('th-draft')?.status).toBe('draft')
    expect(byId.get('th-archived')?.status).toBe('archived')
  })
})

test('upgrading archives the newer live duplicate a stale hash collides with', () => {
  const path = freshPath('collision')
  buildV48(path)
  openRaw(path, db => {
    seedStale(db, { id: 'th-oldest', content: 'shared body', project_id: 'proj-a' })
    seedLive(db, {
      id: 'th-newer',
      content: 'shared body',
      project_id: 'proj-a',
      created_at: NEWER
    })
  })

  upgrade(path)

  openRaw(path, db => {
    expect(liveIds(db, 'shared body', 'proj-a')).toEqual(['th-oldest'])
    const byId = new Map(thoughtRows(db).map(thought => [thought.id, thought]))
    const archived = byId.get('th-newer')
    expect(archived?.status).toBe('archived')
    expect(archived?.archived_at).not.toBeNull()
    expect(archived?.updated_at).not.toBe(NEWER)
    expect(archived?.is_protected).toBe(0)
    expect(archived?.content_hash).toBe(computeContentHash('shared body', 'proj-a'))
    expect(byId.get('th-oldest')?.content_hash).toBe(computeContentHash('shared body', 'proj-a'))
  })
})

test('a second upgrade run is a no-op', () => {
  const path = freshPath('idempotent')
  buildV48(path)
  openRaw(path, db => {
    seedStale(db, { id: 'th-oldest', content: 'shared body', project_id: 'proj-a' })
    seedLive(db, {
      id: 'th-newer',
      content: 'shared body',
      project_id: 'proj-a',
      created_at: NEWER
    })
    seedStale(db, { id: 'th-solo', content: 'solo', project_id: 'proj-b' })
  })
  upgrade(path)
  const repaired = openRaw(path, db => thoughtRows(db))

  openRaw(path, db => {
    db.prepare(`UPDATE _meta SET value = '48' WHERE key = 'schema_version'`).run()
  })
  upgrade(path)

  openRaw(path, db => {
    expect(schemaVersion(db)).toBe('49')
    expect(thoughtRows(db)).toEqual(repaired)
  })
})

test('upgrading a healthy v048 database touches no thought', () => {
  const path = freshPath('healthy')
  buildV48(path)
  openRaw(path, db => {
    seedLive(db, { id: 'th-a', content: 'kept', project_id: 'proj-a' })
    seedLive(db, {
      id: 'th-archived-duplicate',
      content: 'kept',
      project_id: 'proj-a',
      status: 'archived'
    })
    seedLive(db, { id: 'th-b', content: 'other', project_id: 'proj-b', created_at: NEWER })
  })
  const before = openRaw(path, db => thoughtRows(db))

  upgrade(path)

  openRaw(path, db => {
    expect(schemaVersion(db)).toBe('49')
    expect(thoughtRows(db)).toEqual(before)
  })
})
