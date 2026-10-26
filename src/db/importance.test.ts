import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb, getDb } from './index'
import {
  boostImportance,
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
