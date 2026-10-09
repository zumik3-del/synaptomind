import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { closeDb, getDb } from '../db'
import { createThought, getThoughtRow, updateThought } from '../db/thoughts'
import { createThoughtWithUrlLinks, updateThoughtById } from '../services/thoughts.service'
import { createTestDb, seedThought } from '../test/helpers'

// DB-layer coverage for the is_global flag (epic #1489), mirroring the
// is_protected suite (src/services/is-protected.test.ts).

beforeEach(createTestDb)
afterEach(() => {
  closeDb()
})

function rawIsGlobal(id: string): number | undefined {
  const row = getDb().prepare(`SELECT is_global FROM thoughts WHERE id = ?`).get(id) as
    | { is_global: number }
    | undefined
  return row?.is_global
}

describe('is_global — DB layer', () => {
  test('new thought defaults to is_global = 0', () => {
    const d = getDb()
    const thought = createThought(d, { content: 'default global test' })
    expect(thought.is_global).toBe(0)
    expect(rawIsGlobal(thought.id)).toBe(0)
  })

  test('createThought with is_global = true stores 1', () => {
    const d = getDb()
    const thought = createThought(d, { content: 'global create test', is_global: true })
    expect(thought.is_global).toBe(1)
    expect(rawIsGlobal(thought.id)).toBe(1)
  })

  test('createThought with is_global = false stores 0', () => {
    const d = getDb()
    const thought = createThought(d, { content: 'local create test', is_global: false })
    expect(thought.is_global).toBe(0)
    expect(rawIsGlobal(thought.id)).toBe(0)
  })

  test('updateThought toggles is_global 0 → 1', () => {
    const d = getDb()
    const thought = createThought(d, { content: 'toggle on test' })
    expect(thought.is_global).toBe(0)
    const updated = updateThought(d, thought.id, { is_global: true })
    expect(updated?.is_global).toBe(1)
    expect(rawIsGlobal(thought.id)).toBe(1)
  })

  test('updateThought toggles is_global 1 → 0', () => {
    const d = getDb()
    const thought = createThought(d, { content: 'toggle off test', is_global: true })
    expect(thought.is_global).toBe(1)
    const updated = updateThought(d, thought.id, { is_global: false })
    expect(updated?.is_global).toBe(0)
    expect(rawIsGlobal(thought.id)).toBe(0)
  })

  test('updateThought without is_global preserves the stored value', () => {
    const d = getDb()
    const globalId = createThought(d, { content: 'keep global', is_global: true }).id
    const localId = createThought(d, { content: 'keep local' }).id
    // Touch other columns only — is_global must be untouched.
    updateThought(d, globalId, { content: 'keep global v2' })
    updateThought(d, localId, { status: 'active' })
    expect(getThoughtRow(d, globalId)?.is_global).toBe(1)
    expect(getThoughtRow(d, localId)?.is_global).toBe(0)
  })

  test('getThoughtRow returns the persisted is_global value', () => {
    const d = getDb()
    const id = seedThought({ is_global: 1 })
    expect(getThoughtRow(d, id)?.is_global).toBe(1)
    expect(rawIsGlobal(id)).toBe(1)
  })

  test('seedThought defaults is_global to 0 when not provided', () => {
    const id = seedThought()
    expect(getThoughtRow(getDb(), id)?.is_global).toBe(0)
    expect(rawIsGlobal(id)).toBe(0)
  })
})

describe('is_global — service layer', () => {
  test('createThoughtWithUrlLinks forwards is_global to the row', () => {
    const thought = createThoughtWithUrlLinks({ content: 'svc global create', is_global: true })
    expect(thought.is_global).toBe(1)
    expect(rawIsGlobal(thought.id)).toBe(1)
  })

  test('createThoughtWithUrlLinks defaults is_global to 0', () => {
    const thought = createThoughtWithUrlLinks({ content: 'svc local create' })
    expect(thought.is_global).toBe(0)
  })

  test('updateThoughtById toggles is_global on and back off', () => {
    const thought = createThoughtWithUrlLinks({ content: 'svc toggle' })
    expect(thought.is_global).toBe(0)
    const on = updateThoughtById(thought.id, { is_global: true })
    expect(on?.is_global).toBe(1)
    const off = updateThoughtById(thought.id, { is_global: false })
    expect(off?.is_global).toBe(0)
  })
})
