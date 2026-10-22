import { beforeEach, afterEach, expect, test, describe } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb, getDb } from '../db'
import { archiveThought, createThought, deleteThought, getThoughtRow, updateThought } from '../db/thoughts'
import { cleanupArchivedThoughts } from '../services/ttl-cleanup.service'

beforeEach(createTestDb)
afterEach(() => { closeDb() })

describe('is_protected', () => {
  test('new thought defaults to is_protected = 1', () => {
    const d = getDb()
    const thought = createThought(d, { content: 'test' })
    expect(thought.is_protected).toBe(1)
  })

  test('createThought with is_protected = false', () => {
    const d = getDb()
    const thought = createThought(d, { content: 'test', is_protected: false })
    expect(thought.is_protected).toBe(0)
  })

  test('updateThought can change is_protected', () => {
    const d = getDb()
    const thought = createThought(d, { content: 'test' })
    expect(thought.is_protected).toBe(1)
    const updated = updateThought(d, thought.id, { is_protected: false })
    expect(updated?.is_protected).toBe(0)
  })

  test('archiveThought sets is_protected = 0', () => {
    const d = getDb()
    const thought = createThought(d, { content: 'test' })
    expect(thought.is_protected).toBe(1)
    const archived = archiveThought(d, thought.id)
    expect(archived?.is_protected).toBe(0)
    expect(archived?.status).toBe('archived')
  })

  test('TTL skips protected thoughts', () => {
    const d = getDb()
    const oldDate = new Date(Date.now() - 200 * 86400000).toISOString()
    const protectedId = seedThought({ status: 'archived', is_protected: 1 })
    const unprotectedId = seedThought({ status: 'archived', is_protected: 0 })
    d.prepare(`UPDATE thoughts SET archived_at = ? WHERE id IN (?, ?)`).run(oldDate, protectedId, unprotectedId)
    const result = cleanupArchivedThoughts()
    expect(result.deleted).toBe(1)
    expect(result.ids).toContain(unprotectedId)
    expect(result.ids).not.toContain(protectedId)
    expect(getThoughtRow(d, protectedId)).toBeDefined()
    expect(getThoughtRow(d, unprotectedId)).toBeUndefined()
  })

  test('explicit deleteThought works on protected thoughts', () => {
    const d = getDb()
    const thought = createThought(d, { content: 'test', is_protected: true })
    expect(thought.is_protected).toBe(1)
    const deleted = deleteThought(d, thought.id)
    expect(deleted).toBe(true)
    expect(getThoughtRow(d, thought.id)).toBeUndefined()
  })
})
