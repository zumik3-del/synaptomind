import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { getDb } from './index'
import { closeDb } from './init'
import type { Migration } from './migrations'
import { MIGRATIONS } from './migrations'
import v050 from './migrations/v050-schema-reclamation'
import { BASELINE_TABLE_DDL, META_DDL } from './schema/baseline-schema'

const MEM_OPTS = { isMemory: true, dimensions: 384 }
const V049 = 49
const V050 = 50
const DROPPED_OBJECTS = [
  'index:idx_preview_tokens_target',
  'index:idx_thoughts_content_hash',
  'column:pending_embeddings.last_error',
  'column:pending_embeddings.error'
]
const QUEUE_COLUMNS = ['thought_id', 'created_at', 'attempts', 'is_error', 'content_hash']

beforeEach(createTestDb)
afterEach(closeDb)

function indexNames(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA index_list('${table}')`).all() as { name: string }[]).map(
    row => row.name
  )
}

function columnNames(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as { name: string }[]).map(
    row => row.name
  )
}

/** Every named schema object plus every column, so a stray table, index or trigger fails the set. */
function schemaShape(db: Database): string[] {
  const objects = db
    .prepare(
      `SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
    )
    .all() as { type: string; name: string }[]
  const columns = objects
    .filter(object => object.type === 'table')
    .flatMap(object =>
      columnNames(db, object.name).map(column => `column:${object.name}.${column}`)
    )
  return [...objects.map(object => `${object.type}:${object.name}`), ...columns]
}

function reclaimed(db: Database): string[] {
  const shape = schemaShape(db)
  return DROPPED_OBJECTS.filter(object => shape.includes(object))
}

function buildSchema(migrations: Migration[]): Database {
  const db = new Database(':memory:')
  db.run(META_DDL)
  for (const ddl of BASELINE_TABLE_DDL) db.run(ddl)
  for (const migration of migrations) migration.apply(db, MEM_OPTS)
  return db
}

function untilV049(): Migration[] {
  return MIGRATIONS.filter(migration => migration.version <= V049)
}

function untilV050(): Migration[] {
  return MIGRATIONS.filter(migration => migration.version <= V050)
}

test('v051 is the head migration version', () => {
  expect(MIGRATIONS.at(-1)?.version).toBe(51)
})

test('v050: a migrated DB carries none of the four reclaimed objects', () => {
  const db = getDb()

  expect(indexNames(db, 'thoughts')).not.toContain('idx_thoughts_content_hash')
  expect(indexNames(db, 'thoughts')).toContain('idx_thoughts_content_dedupe')
  expect(indexNames(db, 'preview_tokens')).not.toContain('idx_preview_tokens_target')
  expect(indexNames(db, 'preview_tokens')).toContain('idx_preview_tokens_expires')
  expect(columnNames(db, 'pending_embeddings')).toEqual(QUEUE_COLUMNS)
  expect(reclaimed(db)).toEqual([])
})

test('v050: apply() drops both indexes and both columns, and a second run is a no-op', () => {
  const db = buildSchema(untilV049())
  try {
    expect(indexNames(db, 'thoughts')).toContain('idx_thoughts_content_hash')
    expect(indexNames(db, 'preview_tokens')).toContain('idx_preview_tokens_target')
    expect(columnNames(db, 'pending_embeddings')).toContain('last_error')
    expect(columnNames(db, 'pending_embeddings')).toContain('error')

    v050.apply(db)

    expect(indexNames(db, 'thoughts')).not.toContain('idx_thoughts_content_hash')
    expect(indexNames(db, 'preview_tokens')).not.toContain('idx_preview_tokens_target')
    expect(columnNames(db, 'pending_embeddings')).toEqual(QUEUE_COLUMNS)
    expect(reclaimed(db)).toEqual([])

    const afterFirst = schemaShape(db)
    expect(() => v050.apply(db)).not.toThrow()
    expect(schemaShape(db)).toEqual(afterFirst)
  } finally {
    db.close()
  }
})

test('v050: a fresh DB and a v049 -> v050 upgraded DB have the same schema shape', () => {
  const fresh = buildSchema(untilV050())
  const upgraded = buildSchema(untilV049())
  try {
    const freshShape = schemaShape(fresh)
    expect(reclaimed(fresh)).toEqual([])
    expect(reclaimed(upgraded)).toEqual(DROPPED_OBJECTS)

    v050.apply(upgraded)

    expect(schemaShape(upgraded)).toEqual(freshShape)
    expect(reclaimed(upgraded)).toEqual([])
    expect(columnNames(upgraded, 'pending_embeddings')).toEqual(QUEUE_COLUMNS)
  } finally {
    fresh.close()
    upgraded.close()
  }
})

test('v050: the drop keeps every queued row and its values', () => {
  const db = buildSchema(untilV049())
  try {
    db.prepare(
      `INSERT INTO thoughts (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)`
    ).run('th-queued', 'queued body', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    db.prepare(
      `UPDATE pending_embeddings
       SET attempts = 4, is_error = 1, last_error = 'boom 4', error = 'boom 4', content_hash = 'h'
       WHERE thought_id = ?`
    ).run('th-queued')

    v050.apply(db)

    expect(db.prepare(`SELECT * FROM pending_embeddings`).all()).toEqual([
      {
        thought_id: 'th-queued',
        created_at: expect.any(String),
        attempts: 4,
        is_error: 1,
        content_hash: 'h'
      }
    ])
  } finally {
    db.close()
  }
})

test('v050: a column still named by an index makes the drop throw instead of passing silently', () => {
  const db = buildSchema(untilV049())
  try {
    db.exec(`CREATE INDEX probe_error ON pending_embeddings(error) WHERE error IS NOT NULL`)

    expect(() => v050.apply(db)).toThrow(/error in index probe_error/)
    expect(columnNames(db, 'pending_embeddings')).toContain('error')
  } finally {
    db.close()
  }
})

test('v050: the queue triggers still fire and the foreign key still cascades', () => {
  const db = getDb()
  const queued = seedThought({ content: 'queued after v050' })
  expect(
    db.prepare(`SELECT attempts, is_error FROM pending_embeddings WHERE thought_id = ?`).get(queued)
  ).toEqual({ attempts: 0, is_error: 0 })

  db.prepare(`DELETE FROM pending_embeddings WHERE thought_id = ?`).run(queued)
  db.prepare(`UPDATE thoughts SET content = 'edited after v050' WHERE id = ?`).run(queued)
  expect(
    db.prepare(`SELECT 1 FROM pending_embeddings WHERE thought_id = ?`).get(queued)
  ).not.toBeNull()

  db.prepare(`DELETE FROM thoughts WHERE id = ?`).run(queued)
  expect(db.prepare(`SELECT 1 FROM pending_embeddings WHERE thought_id = ?`).get(queued)).toBeNull()
})
