import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb } from '../test/helpers'
import { getDb } from './index'
import { closeDb } from './init'
import type { Migration } from './migrations'
import { MIGRATIONS } from './migrations'
import v051 from './migrations/v051-drop-placement-proposals'
import { BASELINE_TABLE_DDL, META_DDL } from './schema/baseline-schema'

const MEM_OPTS = { isMemory: true, dimensions: 384 }
const V050 = 50
const PROPOSAL_INDEXES = ['idx_pp_dedup', 'idx_pp_pending', 'idx_pp_run', 'idx_pp_source']
const PROPOSAL_ROW = {
  id: 'proposal-1',
  source_thought_id: 'th-1',
  item_kind: 'edge',
  confidence: 0.8,
  rationale: 'queued before the drop',
  payload: '{}',
  fingerprint: 'fp-1',
  created_at: '2026-01-01T00:00:00.000Z'
}

beforeEach(createTestDb)
afterEach(closeDb)

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

function proposalObjects(db: Database): string[] {
  return schemaShape(db).filter(entry => entry.includes('placement_') || entry.includes('idx_pp_'))
}

function tableNames(db: Database): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as {
      name: string
    }[]
  ).map(row => row.name)
}

function indexNames(db: Database): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`
      )
      .all() as { name: string }[]
  ).map(row => row.name)
}

function rowCount(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n
}

function buildSchema(migrations: Migration[]): Database {
  const db = new Database(':memory:')
  db.run(META_DDL)
  for (const ddl of BASELINE_TABLE_DDL) db.run(ddl)
  for (const migration of migrations) migration.apply(db, MEM_OPTS)
  return db
}

function untilV050(): Migration[] {
  return MIGRATIONS.filter(migration => migration.version <= V050)
}

function insertProposalRow(db: Database): void {
  db.prepare(
    `INSERT INTO placement_proposals
       (id, source_thought_id, item_kind, confidence, rationale, payload, fingerprint, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    PROPOSAL_ROW.id,
    PROPOSAL_ROW.source_thought_id,
    PROPOSAL_ROW.item_kind,
    PROPOSAL_ROW.confidence,
    PROPOSAL_ROW.rationale,
    PROPOSAL_ROW.payload,
    PROPOSAL_ROW.fingerprint,
    PROPOSAL_ROW.created_at
  )
}

test('v051: the migrated head carries neither the table nor its indexes', () => {
  expect(proposalObjects(getDb())).toEqual([])
})

test('v051: apply() drops a v050 table that still has its rows and indexes', () => {
  const db = buildSchema(untilV050())
  try {
    expect(tableNames(db)).toContain('placement_proposals')
    expect(indexNames(db)).toEqual(expect.arrayContaining(PROPOSAL_INDEXES))
    insertProposalRow(db)

    v051.apply(db)

    expect(proposalObjects(db)).toEqual([])
    for (const name of PROPOSAL_INDEXES) expect(indexNames(db)).not.toContain(name)
  } finally {
    db.close()
  }
})

test('v051: a second apply() is a no-op', () => {
  const db = buildSchema(untilV050())
  try {
    insertProposalRow(db)

    v051.apply(db)
    const afterFirst = schemaShape(db)

    expect(() => v051.apply(db)).not.toThrow()
    expect(schemaShape(db)).toEqual(afterFirst)
  } finally {
    db.close()
  }
})

test('v051: a fresh head and a v050 -> v051 upgrade agree on the whole schema shape', () => {
  const fresh = buildSchema(MIGRATIONS)
  const upgraded = buildSchema(untilV050())
  try {
    const freshShape = schemaShape(fresh)
    expect(proposalObjects(fresh)).toEqual([])
    expect(proposalObjects(upgraded)).not.toEqual([])

    v051.apply(upgraded)

    expect(schemaShape(upgraded)).toEqual(freshShape)
  } finally {
    fresh.close()
    upgraded.close()
  }
})

test('v051: every other table, its rows and its indexes survive the drop', () => {
  const db = buildSchema(untilV050())
  try {
    db.prepare(
      `INSERT INTO thoughts (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)`
    ).run('th-1', 'kept across the drop', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    insertProposalRow(db)

    const tables = tableNames(db)
    const indexes = indexNames(db)
    const counts = Object.fromEntries(tables.map(table => [table, rowCount(db, table)]))

    v051.apply(db)

    const survivingTables = tables.filter(name => name !== 'placement_proposals')
    expect(tableNames(db)).toEqual(survivingTables)
    expect(indexNames(db)).toEqual(indexes.filter(name => !PROPOSAL_INDEXES.includes(name)))
    for (const table of survivingTables) {
      expect({ table, rows: rowCount(db, table) }).toEqual({ table, rows: counts[table] })
    }
    expect(db.prepare(`SELECT content FROM thoughts WHERE id = 'th-1'`).get()).toEqual({
      content: 'kept across the drop'
    })
  } finally {
    db.close()
  }
})
