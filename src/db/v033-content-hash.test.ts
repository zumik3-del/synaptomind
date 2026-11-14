import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { BASELINE_TABLE_DDL, META_DDL } from './baseline-schema'
import v033 from './migrations/v033-content-hash'

function legacyDb(): Database {
  const db = new Database(':memory:')
  db.run(META_DDL)
  for (const ddl of BASELINE_TABLE_DDL) db.run(ddl)
  return db
}

function seedThought(db: Database, id: string, content: string, projectId: string | null): void {
  db.prepare(
    `INSERT INTO thoughts (id, content, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, content, projectId, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
}

function hashes(db: Database): Record<string, string> {
  const rows = db.prepare(`SELECT id, content_hash FROM thoughts ORDER BY id`).all() as {
    id: string
    content_hash: string
  }[]
  return Object.fromEntries(rows.map(row => [row.id, row.content_hash]))
}

function expectedHash(content: string, projectId: string | null): string {
  return createHash('sha256')
    .update(content + projectId)
    .digest('hex')
}

test('v033 backfills the per-project content hash of every existing thought', () => {
  const db = legacyDb()
  try {
    seedThought(db, 'a', 'first body', 'proj-1')
    seedThought(db, 'b', 'first body', 'proj-2')

    v033.apply(db)

    expect(hashes(db)).toEqual({
      a: expectedHash('first body', 'proj-1'),
      b: expectedHash('first body', 'proj-2')
    })
    expect(hashes(db).a).not.toBe(hashes(db).b)
  } finally {
    db.close(true)
  }
})

test('v033 leaves an existing hash alone and only fills the NULL rows', () => {
  const db = legacyDb()
  try {
    seedThought(db, 'kept', 'already hashed', 'proj-1')
    db.run(`ALTER TABLE thoughts ADD COLUMN content_hash TEXT`)
    db.prepare(`UPDATE thoughts SET content_hash = 'preset' WHERE id = 'kept'`).run()
    seedThought(db, 'filled', 'needs a hash', 'proj-1')

    v033.apply(db)

    expect(hashes(db)).toEqual({
      kept: 'preset',
      filled: expectedHash('needs a hash', 'proj-1')
    })
  } finally {
    db.close(true)
  }
})

test('v033 adds the lookup index the dedupe guard needs, and is replayable', () => {
  const db = legacyDb()
  try {
    seedThought(db, 'a', 'body', 'proj-1')

    v033.apply(db)
    const first = hashes(db)
    v033.apply(db)

    const indexes = (db.prepare(`PRAGMA index_list('thoughts')`).all() as { name: string }[]).map(
      row => row.name
    )
    expect(indexes).toContain('idx_thoughts_content_hash')
    expect(hashes(db)).toEqual(first)
  } finally {
    db.close(true)
  }
})
