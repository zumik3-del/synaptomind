import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../context/container'
import { closeDb } from './init'
import {
  createTestDb,
  isVecExtensionAvailable,
  seedEmbedding,
  seedThought,
  withVecDb
} from '../test/helpers'
import { deleteThought } from './thoughts'

const VEC_AVAILABLE = isVecExtensionAvailable()

/**
 * Vec-gated test. `:memory:` cannot load vec0, so each body runs on a fresh
 * file-backed DB supplied by `withVecDb` and skips when the extension is absent.
 */
function itVec(name: string, fn: (db: Database) => void | Promise<void>): void {
  test.skipIf(!VEC_AVAILABLE)(name, () => withVecDb(fn))
}

beforeEach(createTestDb)
afterEach(closeDb)

function count(sql: string, ...args: string[]): number {
  const row = getDb()
    .prepare(sql)
    .get(...args) as { n: number } | undefined
  return row?.n ?? 0
}

function thoughtRows(id: string): number {
  return count('SELECT COUNT(*) AS n FROM thoughts WHERE id = ?', id)
}

itVec('deleteThought keeps the vector row when the thoughts delete aborts', db => {
  const id = seedThought({ content: 'atomic delete probe', tags: '["probe-tag"]' })
  seedEmbedding(id)
  expect(count('SELECT COUNT(*) AS n FROM vec_thoughts WHERE id = ?', id)).toBe(1)

  db.run(
    `CREATE TRIGGER probe_block_thought_delete BEFORE DELETE ON thoughts
     WHEN OLD.id = '${id}'
     BEGIN SELECT RAISE(ABORT, 'probe: thought delete blocked'); END`
  )

  expect(() => deleteThought(db, id)).toThrow('probe: thought delete blocked')

  expect(count('SELECT COUNT(*) AS n FROM vec_thoughts WHERE id = ?', id)).toBe(1)
  expect(thoughtRows(id)).toBe(1)
  expect(count('SELECT COUNT(*) AS n FROM thought_tags WHERE thought_id = ?', id)).toBe(1)
})

itVec('deleteThought rethrows a vec_thoughts failure that is not "no such table"', db => {
  const id = seedThought({ content: 'vecless probe' })
  db.run('DROP TABLE vec_thoughts')
  db.run('CREATE TABLE vec_thoughts (id TEXT NOT NULL)')
  db.prepare('INSERT INTO vec_thoughts (id) VALUES (?)').run(id)
  // The schema's own AFTER DELETE trigger clears vec_thoughts once the thoughts row is already
  // gone; the guard makes only the explicit first delete fail.
  db.run(
    `CREATE TRIGGER probe_block_vec_delete BEFORE DELETE ON vec_thoughts
     WHEN EXISTS (SELECT 1 FROM thoughts WHERE id = OLD.id)
     BEGIN SELECT RAISE(ABORT, 'probe: vector delete blocked'); END`
  )

  expect(() => deleteThought(db, id)).toThrow('probe: vector delete blocked')

  expect(thoughtRows(id)).toBe(1)
})

test('deleteThought still succeeds on a DB without a vec_thoughts table', () => {
  const id = seedThought({ content: 'no vector table' })
  const db = getDb()
  expect(() => db.prepare('SELECT 1 FROM vec_thoughts LIMIT 1').get()).toThrow(
    'no such table: vec_thoughts'
  )

  expect(deleteThought(db, id)).toBe(true)

  expect(thoughtRows(id)).toBe(0)
})
