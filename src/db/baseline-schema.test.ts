import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { BASELINE_TABLE_DDL, META_DDL } from './baseline-schema'

function tables(db: Database): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as {
      name: string
    }[]
  ).map(row => row.name)
}

function columns(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(r => r.name)
}

test('the baseline DDL creates _meta and the four pre-baseline tables', () => {
  const db = new Database(':memory:')
  try {
    db.run(META_DDL)
    for (const ddl of BASELINE_TABLE_DDL) db.run(ddl)

    expect(tables(db)).toEqual(['_meta', 'edges', 'preview_tokens', 'projects', 'thoughts'])
    expect(columns(db, '_meta')).toEqual(['key', 'value'])
    expect(columns(db, 'thoughts')).toContain('project_id')
    // A post-baseline column is exactly what the lost-stamp guard must not expect here.
    expect(columns(db, 'thoughts')).not.toContain('archived_at')
    expect(columns(db, 'edges')).toEqual(['id', 'source_id', 'target_id', 'type', 'created_at'])
    expect(columns(db, 'projects')).toEqual(['id', 'name', 'description', 'created_at'])
    expect(columns(db, 'preview_tokens')).toEqual([
      'token',
      'kind',
      'target_id',
      'fingerprint',
      'created_at',
      'expires_at'
    ])
  } finally {
    db.close(true)
  }
})

test('the baseline DDL is idempotent, so a boot can replay it over an existing file', () => {
  const db = new Database(':memory:')
  try {
    for (let pass = 0; pass < 2; pass++) {
      db.run(META_DDL)
      for (const ddl of BASELINE_TABLE_DDL) db.run(ddl)
    }

    expect(tables(db)).toEqual(['_meta', 'edges', 'preview_tokens', 'projects', 'thoughts'])
  } finally {
    db.close(true)
  }
})

test('edges keeps the one-row-per-directed-type constraint the write model relies on', () => {
  const db = new Database(':memory:')
  try {
    db.run(META_DDL)
    for (const ddl of BASELINE_TABLE_DDL) db.run(ddl)
    db.prepare(
      `INSERT INTO thoughts (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)`
    ).run('a', 'x', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    const insert = db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, ?, ?)`
    )
    insert.run('e1', 'a', 'a', 'develops', '2026-01-01T00:00:00.000Z')

    expect(() => insert.run('e2', 'a', 'a', 'develops', '2026-01-01T00:00:00.000Z')).toThrow(
      'UNIQUE'
    )
  } finally {
    db.close(true)
  }
})
