import { Database } from 'bun:sqlite'
import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../config'
import { vec0Path } from '../runtime-mode'
import { computeContentHash } from '../utils'
import { getDb } from '../context/container'
import { closeDb, initDb } from './init'
import { MIGRATIONS } from './migrations'

const tmpRoot = mkdtempSync(join(tmpdir(), 'synaptomind-v046-'))

afterEach(() => {
  closeDb()
})

afterAll(() => {
  closeDb()
  rmSync(tmpRoot, { recursive: true, force: true })
})

let fixtureCount = 0

const V45 = 45

function buildV45(path: string): void {
  initDb({ dbPath: path, runMigrations: false })
  const db = getDb()
  const stamp = db.prepare(
    `INSERT INTO _meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
  for (const migration of MIGRATIONS) {
    if (migration.version > V45) continue
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

function insertThought(
  db: Database,
  row: {
    id: string
    content: string
    project_id: string | null
    content_hash?: string | null
    status?: string
    created_at?: string
    is_protected?: number
  }
): void {
  db.prepare(`
    INSERT INTO thoughts (id, content, status, source, project_id, content_hash, is_cluster, is_profile, is_protected, is_global, created_at, updated_at, surface_after, archived_at)
    VALUES (?, ?, ?, NULL, ?, ?, 0, 0, ?, 0, ?, ?, NULL, NULL)
  `).run(
    row.id,
    row.content,
    row.status ?? 'active',
    row.project_id,
    row.content_hash === undefined ? null : row.content_hash,
    row.is_protected ?? 1,
    row.created_at ?? '2020-01-01T00:00:00.000Z',
    row.created_at ?? '2020-01-01T00:00:00.000Z'
  )
}

function insertEdge(db: Database, id: string, source: string, target: string, type: string): void {
  db.prepare(
    `INSERT INTO edges (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, source, target, type, '2020-01-01T00:00:00.000Z')
}

function insertProject(db: Database, id: string, name: string): void {
  db.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`).run(
    id,
    name,
    '2020-01-01T00:00:00.000Z'
  )
}

test('v046 drops self-loops and keeps one edge per pair, a specific relation beating related', () => {
  const path = freshPath('edges')
  buildV45(path)
  openRaw(path, db => {
    for (const id of ['th-a', 'th-b', 'th-c'])
      insertThought(db, { id, content: `content ${id}`, project_id: null })
    insertEdge(db, 'edge-1-related', 'th-a', 'th-b', 'related')
    insertEdge(db, 'edge-2-develops', 'th-b', 'th-a', 'develops')
    insertEdge(db, 'edge-z9', 'th-b', 'th-c', 'related')
    insertEdge(db, 'edge-a1', 'th-c', 'th-b', 'related')
    insertEdge(db, 'edge-self', 'th-c', 'th-c', 'related')
  })

  initDb({ dbPath: path, runMigrations: true })
  closeDb()

  openRaw(path, db => {
    expect(schemaVersion(db)).toBe('49')
    const remaining = (
      db.prepare(`SELECT id FROM edges ORDER BY id`).all() as { id: string }[]
    ).map(r => r.id)
    expect(remaining).toEqual(['edge-2-develops', 'edge-a1'])
    expect(() => insertEdge(db, 'edge-late', 'th-a', 'th-b', 'supports')).toThrow(
      'UNIQUE constraint failed'
    )
  })
})

test('v046 backfills content_hash through computeContentHash and keeps the oldest live duplicate', () => {
  const path = freshPath('thoughts')
  buildV45(path)
  openRaw(path, db => {
    insertProject(db, 'proj-1', 'Project One')
    insertThought(db, {
      id: 'th-old',
      content: 'duplicated content',
      project_id: 'proj-1',
      status: 'active',
      created_at: '2020-01-01T00:00:00.000Z'
    })
    insertThought(db, {
      id: 'th-mid',
      content: 'duplicated content',
      project_id: 'proj-1',
      status: 'active',
      created_at: '2020-02-01T00:00:00.000Z',
      is_protected: 1
    })
    insertThought(db, {
      id: 'th-new',
      content: 'duplicated content',
      project_id: 'proj-1',
      status: 'draft',
      created_at: '2020-03-01T00:00:00.000Z'
    })
    insertThought(db, {
      id: 'th-global',
      content: 'global content',
      project_id: null,
      created_at: '2020-01-01T00:00:00.000Z'
    })
  })

  initDb({ dbPath: path, runMigrations: true })
  closeDb()

  openRaw(path, db => {
    const rows = db
      .prepare(
        `SELECT id, status, content_hash, archived_at, is_protected FROM thoughts ORDER BY id`
      )
      .all() as Array<{
      id: string
      status: string
      content_hash: string | null
      archived_at: string | null
      is_protected: number
    }>
    const byId = new Map(rows.map(r => [r.id, r]))

    const expectedHash = computeContentHash('duplicated content', 'proj-1')
    for (const id of ['th-old', 'th-mid', 'th-new']) {
      expect(byId.get(id)?.content_hash).toBe(expectedHash)
    }
    expect(byId.get('th-global')?.content_hash).toBe(computeContentHash('global content', ''))

    expect(byId.get('th-old')).toMatchObject({
      status: 'active',
      archived_at: null,
      is_protected: 1
    })
    expect(byId.get('th-mid')).toMatchObject({ status: 'archived', is_protected: 0 })
    expect(byId.get('th-new')).toMatchObject({ status: 'archived', is_protected: 0 })
    expect(byId.get('th-mid')?.archived_at).toBeString()
    expect(byId.get('th-new')?.archived_at).toBeString()

    const live = db
      .prepare(
        `SELECT COUNT(*) AS c FROM thoughts WHERE content_hash = ? AND project_id = 'proj-1' AND status IN ('draft','active')`
      )
      .get(expectedHash) as { c: number }
    expect(live.c).toBe(1)
  })
})

test('replaying v046 on an already-repaired database changes nothing', () => {
  const path = freshPath('replay')
  buildV45(path)
  openRaw(path, db => {
    for (const id of ['th-a', 'th-b'])
      insertThought(db, { id, content: `content ${id}`, project_id: null })
    insertThought(db, {
      id: 'th-dup',
      content: 'content th-a',
      project_id: null,
      created_at: '2020-02-02T00:00:00.000Z'
    })
    insertEdge(db, 'edge-1', 'th-a', 'th-b', 'related')
    insertEdge(db, 'edge-2', 'th-b', 'th-a', 'develops')
  })

  initDb({ dbPath: path, runMigrations: true })
  closeDb()

  const snapshot = (): unknown =>
    openRaw(path, db => ({
      thoughts: db
        .prepare(`SELECT id, status, content_hash, archived_at FROM thoughts ORDER BY id`)
        .all(),
      edges: db.prepare(`SELECT id FROM edges ORDER BY id`).all()
    }))

  const repaired = snapshot()

  openRaw(path, db => {
    db.prepare(
      `INSERT INTO _meta (key, value) VALUES ('schema_version', '45')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run()
  })
  initDb({ dbPath: path, runMigrations: true })
  closeDb()

  expect(snapshot()).toEqual(repaired)
})
