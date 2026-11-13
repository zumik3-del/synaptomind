import { Database } from 'bun:sqlite'
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../config'
import { getDb } from '../context/container'
import { isVecExtensionAvailable, seedEmbedding, seedThought, withVecDb } from '../test/helpers'
import { vec0Path } from '../runtime-mode'
import { runHealthCheckService } from '../services/health-check.service'
import { findScopeMismatches } from './health-check/embeddings'
import { closeDb, initDb } from './init'
import { MIGRATIONS } from './migrations'
import { insertEmbedding } from './pending-embeddings'
import { deleteProject } from './projects'
import { searchThoughts } from './search'
import { deleteThought } from './thoughts'
import { scopeSql } from './vec-schema'

const DIMENSIONS = config.embedder.dimensions
const V47 = 47
const POOL_MAX = 1000
const VEC_AVAILABLE = isVecExtensionAvailable()

const GLOBAL = '__global__'
const UNASSIGNED = '__unassigned__'

/** The partition expression the ADR specifies, spelled out instead of imported. */
const EXPECTED_SCOPE_SQL = `CASE WHEN t.is_global = 1 THEN '${GLOBAL}'
  WHEN t.project_id IS NULL THEN '${UNASSIGNED}' ELSE t.project_id END`

function itVec(name: string, fn: (db: Database) => void | Promise<void>): void {
  test.skipIf(!VEC_AVAILABLE)(name, () => withVecDb(fn))
}

afterEach(() => {
  closeDb()
})

const tmpRoot = mkdtempSync(join(tmpdir(), 'synaptomind-v048-'))
let fixtureCount = 0

afterAll(() => {
  closeDb()
  rmSync(tmpRoot, { recursive: true, force: true })
})

function freshPath(label: string): string {
  fixtureCount += 1
  return join(tmpRoot, `${label}-${fixtureCount}.db`)
}

function legacyVecTableDdl(dimensions: number): string {
  return `CREATE VIRTUAL TABLE vec_thoughts USING vec0(
    id        TEXT PRIMARY KEY,
    embedding FLOAT[${dimensions}] distance_metric=cosine
  )`
}

function buildV47(path: string): void {
  initDb({ dbPath: path, runMigrations: false })
  const db = getDb()
  const stamp = db.prepare(
    `INSERT INTO _meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
  for (const migration of MIGRATIONS) {
    if (migration.version > V47) continue
    db.transaction(() => {
      migration.apply(db, { isMemory: false, dimensions: DIMENSIONS })
      stamp.run(String(migration.version))
    })()
  }
  db.exec(`DROP TABLE IF EXISTS vec_thoughts`)
  db.exec(legacyVecTableDdl(DIMENSIONS))
  closeDb()
}

function openRaw<T>(path: string, fn: (db: Database) => T): T {
  const db = new Database(path)
  try {
    // v048's move trigger lives on `thoughts`, so writes there need the extension.
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

function metaValue(db: Database, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM _meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined
  return row?.value
}

function objectNames(db: Database, type: 'table' | 'trigger' | 'index'): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = ? ORDER BY name`).all(type) as Array<{
      name: string
    }>
  ).map(row => row.name)
}

function insertProject(db: Database, id: string): void {
  db.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`).run(
    id,
    id,
    '2020-01-01T00:00:00.000Z'
  )
}

function insertThought(
  db: Database,
  row: { id: string; project_id: string | null; is_global?: number }
): void {
  const stamp = '2020-01-01T00:00:00.000Z'
  db.prepare(`
    INSERT INTO thoughts (id, content, status, source, project_id, content_hash, is_cluster, is_protected, is_global, created_at, updated_at)
    VALUES (?, ?, 'active', 'test', ?, NULL, 0, 1, ?, ?, ?)
  `).run(row.id, `content of ${row.id}`, row.project_id, row.is_global ?? 0, stamp, stamp)
}

function vectorBuffer(marker: number): Buffer {
  const vector = new Float32Array(DIMENSIONS)
  vector[0] = marker
  return Buffer.from(vector.buffer as ArrayBuffer, vector.byteOffset, vector.byteLength)
}

function blobHex(blob: Buffer): string {
  return blob.toString('hex').toUpperCase()
}

function vecRows(db: Database): Array<{ id: string; scope: string; hex: string }> {
  return db
    .prepare(`SELECT id, scope, hex(embedding) AS hex FROM vec_thoughts ORDER BY id`)
    .all() as Array<{ id: string; scope: string; hex: string }>
}

function scopesById(db: Database): Record<string, string> {
  return Object.fromEntries(vecRows(db).map(row => [row.id, row.scope]))
}

test.skipIf(!VEC_AVAILABLE)(
  'v048 repartitions every vector and records the migration as done',
  () => {
    const path = freshPath('repartition')
    buildV47(path)
    const seeded = new Map<string, Buffer>()

    openRaw(path, db => {
      expect(() => db.prepare(`SELECT scope FROM vec_thoughts`).get()).toThrow()

      insertProject(db, 'proj-a')
      insertProject(db, 'proj-b')
      insertThought(db, { id: 'th-a', project_id: 'proj-a' })
      insertThought(db, { id: 'th-b', project_id: 'proj-b' })
      insertThought(db, { id: 'th-global', project_id: 'proj-b', is_global: 1 })
      insertThought(db, { id: 'th-unassigned', project_id: null })
      insertThought(db, { id: 'th-no-vector', project_id: 'proj-a' })

      const vectors: Array<[string, number]> = [
        ['th-a', 1],
        ['th-b', 2],
        ['th-global', 3],
        ['th-unassigned', 4]
      ]
      const insert = db.prepare(`INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)`)
      for (const [id, marker] of vectors) {
        const blob = vectorBuffer(marker)
        seeded.set(id, blob)
        insert.run(id, blob)
      }
    })

    initDb({ dbPath: path, runMigrations: true })
    closeDb()

    openRaw(path, db => {
      expect(schemaVersion(db)).toBe('49')
      expect(metaValue(db, 'vec_scope_v048')).toBe('done')

      expect(vecRows(db).map(row => row.id)).toEqual(['th-a', 'th-b', 'th-global', 'th-unassigned'])
      expect((db.prepare(`SELECT COUNT(*) AS n FROM vec_thoughts`).get() as { n: number }).n).toBe(
        seeded.size
      )

      expect(scopesById(db)).toEqual({
        'th-a': 'proj-a',
        'th-b': 'proj-b',
        'th-global': GLOBAL,
        'th-unassigned': UNASSIGNED
      })
      const disagreeing = db
        .prepare(`
          SELECT COUNT(*) AS n
          FROM vec_thoughts v
          JOIN thoughts t ON t.id = v.id
          WHERE v.scope <> (${EXPECTED_SCOPE_SQL})
        `)
        .get() as { n: number }
      expect(disagreeing.n).toBe(0)
      expect(findScopeMismatches(db)).toEqual([])

      for (const row of vecRows(db)) {
        expect(row.hex).toBe(blobHex(seeded.get(row.id)!))
      }

      expect(objectNames(db, 'table').filter(name => name.includes('scope_stage'))).toEqual([])
      expect(objectNames(db, 'index').filter(name => name.includes('scope_stage'))).toEqual([])
      expect(objectNames(db, 'trigger')).toContain('trg_thoughts_vec_scope')
      expect(objectNames(db, 'table')).toContain('vec_scope_move')
      expect(objectNames(db, 'index')).toContain('idx_thoughts_is_global')
    })
  }
)

test.skipIf(!VEC_AVAILABLE)('v048 drops a vector whose thought no longer exists', () => {
  const path = freshPath('orphan')
  buildV47(path)
  openRaw(path, db => {
    insertProject(db, 'proj-a')
    insertThought(db, { id: 'th-a', project_id: 'proj-a' })
    const insert = db.prepare(`INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)`)
    insert.run('th-a', vectorBuffer(1))
    insert.run('th-ghost', vectorBuffer(2))
  })

  initDb({ dbPath: path, runMigrations: true })
  closeDb()

  openRaw(path, db => {
    expect(schemaVersion(db)).toBe('49')
    expect(vecRows(db).map(row => row.id)).toEqual(['th-a'])
    expect(vecRows(db)[0]!.scope).toBe('proj-a')
  })
})

test.skipIf(!VEC_AVAILABLE)(
  'a resumed v048 re-run leaves every partition and blob untouched',
  () => {
    const path = freshPath('resume')
    buildV47(path)
    openRaw(path, db => {
      insertProject(db, 'proj-a')
      insertProject(db, 'proj-b')
      insertThought(db, { id: 'th-a', project_id: 'proj-a' })
      insertThought(db, { id: 'th-global', project_id: 'proj-b', is_global: 1 })
      const insert = db.prepare(`INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)`)
      insert.run('th-a', vectorBuffer(1))
      insert.run('th-global', vectorBuffer(2))
    })

    initDb({ dbPath: path, runMigrations: true })
    closeDb()

    const snapshot = (): unknown =>
      openRaw(path, db => ({
        version: schemaVersion(db),
        marker: metaValue(db, 'vec_scope_v048'),
        rows: vecRows(db),
        triggers: objectNames(db, 'trigger').filter(name => name.startsWith('trg_thoughts_vec'))
      }))

    const upgraded = snapshot()
    expect((upgraded as { version: string }).version).toBe('49')

    openRaw(path, db => {
      db.prepare(`UPDATE _meta SET value = '47' WHERE key = 'schema_version'`).run()
    })
    initDb({ dbPath: path, runMigrations: true })
    closeDb()

    expect(snapshot()).toEqual(upgraded)
  }
)

function storeVector(db: Database, thoughtId: string, blob: Buffer): void {
  db.prepare(
    `INSERT INTO vec_thoughts (id, embedding, scope)
     SELECT ?, ?, ${scopeSql('t')} FROM thoughts t WHERE t.id = ?`
  ).run(thoughtId, blob, thoughtId)
}

/**
 * vec0's internal rowid for a vector row. vec0 refuses an `UPDATE` on the
 * partition column, so a move is a delete + insert, which always takes a fresh
 * rowid — the only observable trace of a rewrite when id, blob and partition end
 * up identical.
 */
function internalRowid(db: Database, id: string): number | undefined {
  const row = db.prepare(`SELECT rowid FROM vec_thoughts_rowids WHERE id = ?`).get(id) as
    | { rowid: number }
    | undefined
  return row?.rowid
}

describe('the v048 move trigger', () => {
  itVec('a project change moves the row into the new partition, blob unchanged', db => {
    const id = seedThought({ content: 'moving thought', project_id: 'proj-a' })
    const blob = vectorBuffer(7)
    storeVector(db, id, blob)
    const before = internalRowid(db, id)

    db.prepare(`UPDATE thoughts SET project_id = 'proj-b' WHERE id = ?`).run(id)

    expect(scopesById(db)).toEqual({ [id]: 'proj-b' })
    expect(vecRows(db)).toHaveLength(1)
    expect(vecRows(db)[0]!.hex).toBe(blobHex(blob))
    expect(internalRowid(db, id)).not.toBe(before)
    expect((db.prepare(`SELECT COUNT(*) AS n FROM vec_scope_move`).get() as { n: number }).n).toBe(
      0
    )
  })

  itVec('toggling is_global moves the row to the global partition and back', db => {
    const id = seedThought({ content: 'global candidate', project_id: 'proj-a' })
    const blob = vectorBuffer(9)
    storeVector(db, id, blob)

    db.prepare(`UPDATE thoughts SET is_global = 1 WHERE id = ?`).run(id)
    expect(scopesById(db)).toEqual({ [id]: GLOBAL })
    expect(vecRows(db)[0]!.hex).toBe(blobHex(blob))

    db.prepare(`UPDATE thoughts SET is_global = 0 WHERE id = ?`).run(id)
    expect(scopesById(db)).toEqual({ [id]: 'proj-a' })
    expect(vecRows(db)[0]!.hex).toBe(blobHex(blob))
  })

  itVec('a thought with no project lands in the unassigned partition', db => {
    const id = seedThought({ content: 'ownerless thought', project_id: 'proj-a' })
    storeVector(db, id, vectorBuffer(11))

    db.prepare(`UPDATE thoughts SET project_id = NULL WHERE id = ?`).run(id)

    expect(scopesById(db)).toEqual({ [id]: UNASSIGNED })
    expect(vecRows(db)).toHaveLength(1)
  })

  itVec('a no-op UPDATE neither rewrites nor moves the row', db => {
    const id = seedThought({ content: 'stationary thought', project_id: 'proj-a' })
    storeVector(db, id, vectorBuffer(13))
    const rowid = internalRowid(db, id)

    db.prepare(`UPDATE thoughts SET project_id = 'proj-a' WHERE id = ?`).run(id)
    db.prepare(`UPDATE thoughts SET is_global = 0 WHERE id = ?`).run(id)
    db.prepare(`UPDATE thoughts SET content = 'edited content' WHERE id = ?`).run(id)

    expect(internalRowid(db, id)).toBe(rowid)
    expect(scopesById(db)).toEqual({ [id]: 'proj-a' })
    expect(vecRows(db)).toHaveLength(1)
    expect((db.prepare(`SELECT COUNT(*) AS n FROM vec_scope_move`).get() as { n: number }).n).toBe(
      0
    )
  })

  itVec('moving a thought that has no vector row is a no-op', db => {
    const id = seedThought({ content: 'never embedded', project_id: 'proj-a' })

    db.prepare(`UPDATE thoughts SET project_id = 'proj-b' WHERE id = ?`).run(id)

    const moved = db.prepare(`SELECT project_id FROM thoughts WHERE id = ?`).get(id) as {
      project_id: string
    }
    expect(moved.project_id).toBe('proj-b')
    expect((db.prepare(`SELECT COUNT(*) AS n FROM vec_thoughts`).get() as { n: number }).n).toBe(0)
    expect((db.prepare(`SELECT COUNT(*) AS n FROM vec_scope_move`).get() as { n: number }).n).toBe(
      0
    )
  })
})

describe('the deleteProject bulk move', () => {
  itVec('repartitions every embedded thought and drains the move table', db => {
    const defaultId = metaValue(db, 'default_project_id')!
    insertProjectRow(db, 'proj-doomed')
    const seeded = new Map<string, Buffer>()
    const ids = ['bulk-1', 'bulk-2', 'bulk-3', 'bulk-4']
    for (const [index, id] of ids.entries()) {
      seedThought({ id, content: `bulk thought ${id}`, project_id: 'proj-doomed' })
      const blob = vectorBuffer(20 + index)
      storeVector(db, id, blob)
      seeded.set(id, blob)
    }
    const unembedded = seedThought({
      id: 'bulk-no-vector',
      content: 'never embedded',
      project_id: 'proj-doomed'
    })

    expect(deleteProject(db, 'proj-doomed').deleted).toBeTrue()

    expect(db.prepare(`SELECT 1 FROM projects WHERE id = 'proj-doomed'`).get()).toBeNull()
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM thoughts WHERE project_id = 'proj-doomed'`).get() as {
          n: number
        }
      ).n
    ).toBe(0)
    expect(
      (
        db.prepare(`SELECT project_id FROM thoughts WHERE id = ?`).get(unembedded) as {
          project_id: string
        }
      ).project_id
    ).toBe(defaultId)

    expect(scopesById(db)).toEqual(Object.fromEntries(ids.map(id => [id, defaultId])))
    for (const row of vecRows(db)) {
      expect(row.hex).toBe(blobHex(seeded.get(row.id)!))
    }
    const counts = db
      .prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT id) AS ids FROM vec_thoughts`)
      .get() as { n: number; ids: number }
    expect(counts.n).toBe(ids.length)
    expect(counts.ids).toBe(counts.n)
    expect(vecRows(db).some(row => row.id === unembedded)).toBe(false)
    expect((db.prepare(`SELECT COUNT(*) AS n FROM vec_scope_move`).get() as { n: number }).n).toBe(
      0
    )
  })
})

describe('VEC-DEL stays id-only after a move', () => {
  itVec('a delete qualified with the pre-move partition misses the moved row', db => {
    const id = seedThought({ content: 'moved then qualified-deleted', project_id: 'proj-a' })
    storeVector(db, id, vectorBuffer(31))
    db.prepare(`UPDATE thoughts SET project_id = 'proj-b' WHERE id = ?`).run(id)
    expect(scopesById(db)).toEqual({ [id]: 'proj-b' })

    const qualified = db
      .prepare(`DELETE FROM vec_thoughts WHERE id = ? AND scope = ?`)
      .run(id, 'proj-a')
    expect(qualified.changes).toBe(0)
    expect(scopesById(db)).toEqual({ [id]: 'proj-b' })

    db.prepare(`DELETE FROM vec_thoughts WHERE id = ?`).run(id)
    expect(vecRows(db)).toEqual([])
  })

  itVec('deleteThought removes the vector of a thought that already moved', db => {
    const id = seedThought({ content: 'deleted after a move', project_id: 'proj-a' })
    storeVector(db, id, vectorBuffer(33))
    db.prepare(`UPDATE thoughts SET project_id = 'proj-b' WHERE id = ?`).run(id)
    expect(scopesById(db)).toEqual({ [id]: 'proj-b' })

    expect(deleteThought(db, id)).toBeTrue()

    expect(vecRows(db)).toEqual([])
    expect(db.prepare(`SELECT 1 FROM thoughts WHERE id = ?`).get(id)).toBeNull()
  })
})

describe('insertEmbedding writes the partition the thought owns', () => {
  itVec('derives scope from thoughts for every partition', db => {
    insertProjectRow(db, 'proj-a')
    insertProjectRow(db, 'proj-b')
    const owned = seedThought({ content: 'owned', project_id: 'proj-a' })
    const global = seedThought({ content: 'global', project_id: 'proj-b', is_global: 1 })
    const ownerless = seedThought({ content: 'ownerless', project_id: 'proj-a' })
    db.prepare(`UPDATE thoughts SET project_id = NULL WHERE id = ?`).run(ownerless)
    const hash = db.prepare(`UPDATE thoughts SET content_hash = 'h' WHERE id = ?`)
    for (const id of [owned, global, ownerless]) hash.run(id)

    for (const id of [owned, global, ownerless]) {
      expect(insertEmbedding(db, id, new Float32Array(DIMENSIONS), 'h')).toBe(true)
    }

    expect(scopesById(db)).toEqual({
      [owned]: 'proj-a',
      [global]: GLOBAL,
      [ownerless]: UNASSIGNED
    })
  })

  itVec('a thought that moved while queued is embedded into its new partition', db => {
    insertProjectRow(db, 'proj-a')
    insertProjectRow(db, 'proj-b')
    const id = seedThought({ content: 'queued then moved', project_id: 'proj-a' })
    db.prepare(`UPDATE thoughts SET content_hash = 'h' WHERE id = ?`).run(id)
    db.prepare(`UPDATE thoughts SET project_id = 'proj-b' WHERE id = ?`).run(id)

    expect(insertEmbedding(db, id, new Float32Array(DIMENSIONS), 'h')).toBe(true)

    expect(scopesById(db)).toEqual({ [id]: 'proj-b' })
  })

  itVec('re-embedding after a move replaces the row instead of leaving a stale one', db => {
    insertProjectRow(db, 'proj-a')
    insertProjectRow(db, 'proj-b')
    const id = seedThought({ content: 'moved then re-embedded', project_id: 'proj-a' })
    storeVector(db, id, vectorBuffer(3))
    db.prepare(`UPDATE thoughts SET content_hash = 'h2' WHERE id = ?`).run(id)
    db.prepare(`UPDATE thoughts SET project_id = 'proj-b' WHERE id = ?`).run(id)

    expect(insertEmbedding(db, id, new Float32Array(DIMENSIONS), 'h2')).toBe(true)

    expect(scopesById(db)).toEqual({ [id]: 'proj-b' })
    expect(vecRows(db)).toHaveLength(1)
  })
})

describe('findScopeMismatches reports a real mismatch', () => {
  itVec('a vector in the wrong partition is reported by the finder and the health check', db => {
    const id = seedThought({ content: 'misplaced vector', project_id: 'proj-a' })
    db.prepare(`INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, ?)`).run(
      id,
      vectorBuffer(35),
      'proj-elsewhere'
    )

    const expected = [
      {
        id,
        content: 'misplaced vector',
        expected_scope: 'proj-a',
        actual_scope: 'proj-elsewhere'
      }
    ]
    expect(findScopeMismatches(db)).toEqual(expected)

    const report = runHealthCheckService({}, db)
    const drift = report.categories.find(category => category.name === 'data_drift')!
    const check = drift.checks.find(entry => entry.name === 'vector_scope_mismatch')!
    expect(check.severity).toBe('warning')
    expect(check.count).toBe(1)
    expect(check.details).toEqual(expected)
  })
})

function insertProjectRow(db: Database, id: string): void {
  db.prepare(`INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, ?)`).run(
    id,
    id,
    '2020-01-01T00:00:00.000Z'
  )
}

describe('the shared fixture helper', () => {
  itVec('seedEmbedding partitions by the thought it is given', db => {
    const owned = seedThought({ content: 'owned fixture', project_id: 'proj-a' })
    const global = seedThought({ content: 'global fixture', project_id: 'proj-b', is_global: 1 })
    const ownerless = seedThought({ content: 'ownerless fixture', project_id: 'proj-a' })
    db.prepare(`UPDATE thoughts SET project_id = NULL WHERE id = ?`).run(ownerless)

    for (const id of [owned, global, ownerless]) seedEmbedding(id)

    expect(scopesById(db)).toEqual({
      [owned]: 'proj-a',
      [global]: GLOBAL,
      [ownerless]: UNASSIGNED
    })
  })
})

describe('project-scoped semantic search', () => {
  itVec('finds its own rows behind more than the candidate cap of nearer foreign rows', db => {
    const home = seedThought({ content: 'home anchor', project_id: 'proj-home' })
    const global = seedThought({
      content: 'global anchor',
      project_id: 'proj-foreign',
      is_global: 1
    })
    const query = new Float32Array(DIMENSIONS)
    query[0] = 1
    const far = new Float32Array(DIMENSIONS)
    far[1] = 1
    storeVector(db, home, blobOf(far))
    db.prepare(`INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, ?)`).run(
      global,
      blobOf(far),
      GLOBAL
    )
    seedForeignFillers(db, 'proj-foreign', POOL_MAX + 1, blobOf(query))

    const scoped = searchThoughts(db, {
      embedding: query,
      projectFilter: 'proj-home',
      topK: 5,
      hybrid: false
    })

    expect(scoped.map(r => r.thought.id).sort()).toEqual([home, global].sort())
    expect((scoped as { degraded?: boolean }).degraded).toBe(false)

    const unscoped = searchThoughts(db, {
      embedding: query,
      topK: 5,
      hybrid: false
    })
    expect(unscoped).toHaveLength(5)
    expect(unscoped.every(r => r.thought.id.startsWith('filler-'))).toBe(true)
  })
})

function blobOf(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer as ArrayBuffer, vector.byteOffset, vector.byteLength)
}

function seedForeignFillers(
  db: Database,
  projectId: string,
  count: number,
  blob: Buffer
): string[] {
  const now = '2020-01-01T00:00:00.000Z'
  insertProjectRow(db, projectId)
  const insertThought = db.prepare(`
    INSERT INTO thoughts (id, content, status, source, project_id, is_cluster, is_protected, is_global, created_at, updated_at)
    VALUES (?, ?, 'active', 'test', ?, 0, 1, 0, ?, ?)
  `)
  const insertVector = db.prepare(
    `INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, ?)`
  )
  const ids: string[] = []
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `filler-${i}`
      insertThought.run(id, `foreign filler ${i}`, projectId, now, now)
      insertVector.run(id, blob, projectId)
      ids.push(id)
    }
  })()
  return ids
}
