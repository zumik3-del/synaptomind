import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { BASELINE_TABLE_DDL, META_DDL } from './baseline-schema'
import { postBaselineEvidence, readSchemaVersion } from './schema-stamp'

function baselineDb(): Database {
  const db = new Database(':memory:')
  db.run(META_DDL)
  for (const ddl of BASELINE_TABLE_DDL) db.run(ddl)
  return db
}

function withDb<T>(fn: (db: Database) => T): T {
  const db = baselineDb()
  try {
    return fn(db)
  } finally {
    db.close(true)
  }
}

function stamp(db: Database, value: string | null): void {
  db.prepare(`INSERT INTO _meta (key, value) VALUES ('schema_version', ?)`).run(value)
}

function refusal(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  throw new Error('expected the stamp guard to refuse')
}

test('a database carrying nothing beyond the baseline reads as version 0', () => {
  withDb(db => {
    expect(postBaselineEvidence(db)).toEqual([])
    expect(readSchemaVersion(db)).toBe(0)
  })
})

test('a baseline table with an added column is post-baseline evidence', () => {
  withDb(db => {
    db.run(`ALTER TABLE thoughts ADD COLUMN archived_at TEXT`)

    expect(postBaselineEvidence(db)).toEqual(['thoughts.archived_at'])
  })
})

test('evidence is ordered tables, then columns, then other objects', () => {
  withDb(db => {
    db.run(`ALTER TABLE projects ADD COLUMN local_path TEXT`)
    db.run(`CREATE TABLE pending_embeddings (thought_id TEXT)`)
    db.run(`CREATE INDEX idx_thoughts_status ON thoughts(status)`)

    expect(postBaselineEvidence(db)).toEqual([
      'pending_embeddings',
      'projects.local_path',
      'idx_thoughts_status'
    ])
  })
})

test('a missing stamp on a baseline file opens at 0, and on a migrated file refuses', () => {
  withDb(db => {
    expect(readSchemaVersion(db)).toBe(0)

    db.run(`CREATE TABLE pending_embeddings (thought_id TEXT)`)
    const message = refusal(() => readSchemaVersion(db))

    expect(message).toContain('Refusing to open the database: _meta.schema_version is missing')
    expect(message).toContain('1 element(s) that only a migrated database has (pending_embeddings)')
  })
})

test('the evidence list is capped and counts the rest instead of quoting it', () => {
  withDb(db => {
    for (let i = 1; i <= 10; i++) {
      db.run(`CREATE TABLE extra_${String(i).padStart(2, '0')} (id INTEGER)`)
    }

    const message = refusal(() => readSchemaVersion(db))

    expect(message).toContain('extra_08, +2 more')
    expect(message).not.toContain('extra_09')
  })
})

test('a stamped database reads its version as a number', () => {
  withDb(db => {
    stamp(db, '48')

    expect(readSchemaVersion(db)).toBe(48)
  })
})

test('a stamped database with a padded number still reads as that number', () => {
  withDb(db => {
    stamp(db, ' 48 ')

    expect(readSchemaVersion(db)).toBe(48)
  })
})

test('a stamp that is not a migration number is refused with the value it found', () => {
  for (const value of ['v48', '4.8', '-1', null]) {
    withDb(db => {
      stamp(db, value)
      const message = refusal(() => readSchemaVersion(db))

      expect(message).toContain('does not hold a migration number')
      expect(message).toContain(JSON.stringify(value))
      expect(message).toContain('Recovery: stop the unit first')
    })
  }
})
