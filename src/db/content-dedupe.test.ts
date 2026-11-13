import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { getDb } from '../context/container'
import { assertNoLiveContentConflict, isContentDedupeViolation } from './content-dedupe'
import { ThoughtContentConflictError } from './errors'
import { closeDb } from './init'

beforeEach(createTestDb)
afterEach(closeDb)

function hash(content: string, projectId: string): string {
  return `${content}@${projectId}`
}

function seedWithHash(content: string, projectId: string, status: string): string {
  const id = seedThought({ content, project_id: projectId, status })
  getDb()
    .prepare(`UPDATE thoughts SET content_hash = ? WHERE id = ?`)
    .run(hash(content, projectId), id)
  return id
}

describe('assertNoLiveContentConflict', () => {
  test('throws the 409-class conflict naming the live holder', () => {
    const db = getDb()
    const holder = seedWithHash('shared', 'p1', 'active')
    const target = seedWithHash('mine', 'p1', 'draft')

    let thrown: unknown
    try {
      assertNoLiveContentConflict(db, target, hash('shared', 'p1'), 'p1', 'draft')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ThoughtContentConflictError)
    expect((thrown as Error & { statusCode: number }).statusCode).toBe(409)
    expect((thrown as Error).message).toContain(holder)
  })

  test('ignores the thought being edited itself', () => {
    const db = getDb()
    const self = seedWithHash('own content', 'p1', 'active')
    expect(() =>
      assertNoLiveContentConflict(db, self, hash('own content', 'p1'), 'p1', 'active')
    ).not.toThrow()
  })

  test('an archived holder and another project do not block', () => {
    const db = getDb()
    const archived = seedWithHash('freed content', 'p1', 'archived')
    const elsewhere = seedWithHash('other project content', 'p2', 'active')
    const target = seedWithHash('mine', 'p1', 'active')

    expect(() =>
      assertNoLiveContentConflict(db, target, hash('freed content', 'p1'), 'p1', 'active')
    ).not.toThrow()
    expect(() =>
      assertNoLiveContentConflict(db, target, hash('other project content', 'p1'), 'p1', 'active')
    ).not.toThrow()
    expect(archived).toBeString()
    expect(elsewhere).toBeString()
  })

  test('a thought leaving the live statuses is never checked', () => {
    const db = getDb()
    seedWithHash('shared', 'p1', 'active')
    const target = seedWithHash('mine', 'p1', 'draft')
    expect(() =>
      assertNoLiveContentConflict(db, target, hash('shared', 'p1'), 'p1', 'archived')
    ).not.toThrow()
  })

  test('a NULL hash (legacy row) is not checked', () => {
    const db = getDb()
    seedWithHash('shared', 'p1', 'active')
    const target = seedWithHash('mine', 'p1', 'active')
    expect(() => assertNoLiveContentConflict(db, target, null, 'p1', 'active')).not.toThrow()
  })
})

describe('isContentDedupeViolation', () => {
  test('recognises the real partial-unique-index fault', () => {
    const db = getDb()
    const first = seedWithHash('raw one', 'p1', 'active')
    const second = seedWithHash('raw two', 'p1', 'active')

    let thrown: unknown
    try {
      db.prepare(`UPDATE thoughts SET content_hash = ? WHERE id IN (?, ?)`).run(
        hash('collision', 'p1'),
        first,
        second
      )
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect(isContentDedupeViolation(thrown)).toBeTrue()
  })

  test('any other constraint fault stays a plain error', () => {
    const uniqueOther = Object.assign(new Error('UNIQUE constraint failed: thoughts.id'), {
      code: 'SQLITE_CONSTRAINT_UNIQUE'
    })
    expect(isContentDedupeViolation(uniqueOther)).toBeFalse()

    const wrongCode = Object.assign(
      new Error('UNIQUE constraint failed: thoughts.content_hash, thoughts.project_id'),
      {
        code: 'SQLITE_CONSTRAINT_CHECK'
      }
    )
    expect(isContentDedupeViolation(wrongCode)).toBeFalse()

    expect(isContentDedupeViolation(new Error('disk I/O error'))).toBeFalse()
    expect(isContentDedupeViolation('not an error')).toBeFalse()
  })
})
