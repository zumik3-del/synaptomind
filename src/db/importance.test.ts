import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb, getDb } from './index'
import {
  archiveStaleLowImportance,
  batchGetImportance,
  boostImportance,
  boostImportanceBatch,
  decayImportance,
  ensureImportanceRow,
  getThoughtImportance,
  incrementHitCount
} from './importance'

beforeEach(createTestDb)
afterEach(closeDb)

function setImportance(id: string, value: number): void {
  getDb().prepare('UPDATE thought_importance SET importance = ? WHERE thought_id = ?').run(value, id)
}

test('getThoughtImportance returns null for unknown id', () => {
  expect(getThoughtImportance(getDb(), 'nonexistent')).toBeNull()
})

test('getThoughtImportance returns row after seed', () => {
  const id = seedThought()
  const imp = getThoughtImportance(getDb(), id)
  expect(imp).toBeDefined()
  expect(imp!.thought_id).toBe(id)
  expect(imp!.importance).toBe(1.0)
  expect(imp!.hit_count).toBe(0)
})

test('batchGetImportance returns empty map for empty input', () => {
  expect(batchGetImportance(getDb(), []).size).toBe(0)
})

test('batchGetImportance returns map for known ids', () => {
  const a = seedThought()
  const b = seedThought()
  const map = batchGetImportance(getDb(), [a, b, 'nonexistent'])
  expect(map.size).toBe(2)
  expect(map.get(a)).toBeDefined()
  expect(map.get(b)).toBeDefined()
  expect(map.get('nonexistent')).toBeUndefined()
})

test('ensureImportanceRow is idempotent', () => {
  const id = seedThought()
  ensureImportanceRow(getDb(), id)
  ensureImportanceRow(getDb(), id)
  const imp = getThoughtImportance(getDb(), id)
  expect(imp).toBeDefined()
})

test('boostImportance increases importance capped at 1.0', () => {
  const id = seedThought()
  setImportance(id, 0.5)
  boostImportance(getDb(), id, 0.3)
  expect(getThoughtImportance(getDb(), id)!.importance).toBeCloseTo(0.8)
  boostImportance(getDb(), id, 0.5)
  expect(getThoughtImportance(getDb(), id)!.importance).toBe(1.0)
})

test('incrementHitCount increments by 1', () => {
  const id = seedThought()
  incrementHitCount(getDb(), id)
  incrementHitCount(getDb(), id)
  expect(getThoughtImportance(getDb(), id)!.hit_count).toBe(2)
})

test('boostImportanceBatch boosts all ids', () => {
  const a = seedThought()
  const b = seedThought()
  setImportance(a, 0.1)
  setImportance(b, 0.2)
  boostImportanceBatch(getDb(), [a, b], 0.5)
  expect(getThoughtImportance(getDb(), a)!.importance).toBeCloseTo(0.6)
  expect(getThoughtImportance(getDb(), b)!.importance).toBeCloseTo(0.7)
})

test('decayImportance decays old rows', () => {
  const id = seedThought()
  setImportance(id, 0.8)
  const db = getDb()
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString()
  db.prepare('UPDATE thought_importance SET last_decay = ? WHERE thought_id = ?').run(twoDaysAgo, id)
  decayImportance(getDb(), 0.5)
  expect(getThoughtImportance(getDb(), id)!.importance).toBeCloseTo(0.4)
})

test('decayImportance does not touch recently decayed rows', () => {
  const id = seedThought()
  setImportance(id, 0.8)
  decayImportance(getDb(), 0.5)
  expect(getThoughtImportance(getDb(), id)!.importance).toBe(0.8)
})

test('archiveStaleLowImportance archives old low-importance active thoughts', () => {
  const id = seedThought({ is_protected: 0 })
  setImportance(id, 0.05)
  const db = getDb()
  const oldDate = new Date(Date.now() - 30 * 86400000).toISOString()
  db.prepare('UPDATE thought_importance SET created_at = ? WHERE thought_id = ?').run(oldDate, id)
  db.prepare('UPDATE thoughts SET created_at = ? WHERE id = ?').run(oldDate, id)
  const changes = archiveStaleLowImportance(getDb(), 0.1, 7)
  expect(changes).toBe(1)
  const thought = db.prepare('SELECT status FROM thoughts WHERE id = ?').get(id) as { status: string }
  expect(thought.status).toBe('archived')
})

test('archiveStaleLowImportance does not archive profile thoughts', () => {
  const id = seedThought({ is_profile: 1, is_protected: 0 })
  setImportance(id, 0.05)
  const db = getDb()
  const oldDate = new Date(Date.now() - 30 * 86400000).toISOString()
  db.prepare('UPDATE thought_importance SET created_at = ? WHERE thought_id = ?').run(oldDate, id)
  db.prepare('UPDATE thoughts SET created_at = ? WHERE id = ?').run(oldDate, id)
  const changes = archiveStaleLowImportance(getDb(), 0.1, 7)
  expect(changes).toBe(0)
})
