import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb, getDb } from '../db'
import { getSlots, updateExplicitSlot, SLOT_NAMES } from './slots.service'
import { ValidationError } from './errors'

beforeEach(createTestDb)
afterEach(closeDb)

// ── getSlots ─────────────────────────────────────────────────────────────────

test('getSlots returns all 5 slot views', () => {
  const slots = getSlots()
  expect(slots).toHaveLength(5)
  expect(slots.map(s => s.name)).toEqual([...SLOT_NAMES])
})

test('getSlots virtual slots have virtual=true', () => {
  const slots = getSlots()
  const persona = slots.find(s => s.name === 'persona')
  expect(persona?.virtual).toBeTrue()
  expect(persona?.scope).toBe('global')
})

test('getSlots explicit slots have virtual=false', () => {
  const slots = getSlots()
  const projectCtx = slots.find(s => s.name === 'project_context')
  expect(projectCtx?.virtual).toBeFalse()
})

test('getSlots filters by names', () => {
  const slots = getSlots({ names: ['persona', 'active_goals'] })
  expect(slots).toHaveLength(2)
})

test('getSlots persona content from profile thoughts', () => {
  seedThought({ content: 'user prefers concise answers', source: 'profile-summary' })
  const slots = getSlots({ names: ['persona'] })
  expect(slots[0].content).toContain('user prefers concise answers')
})

test('getSlots architecture_decisions content from primers', () => {
  const id = seedThought({ content: 'use SQLite for local storage' })
  const db = getDb()
  db.prepare('INSERT INTO primers (thought_id, hit_count, created_at) VALUES (?, ?, ?)').run(id, 5, new Date().toISOString())
  const slots = getSlots({ names: ['architecture_decisions'] })
  expect(slots[0].content).toContain('use SQLite for local storage')
})

// ── updateExplicitSlot ───────────────────────────────────────────────────────

test('updateExplicitSlot updates project_context', () => {
  const result = updateExplicitSlot('project_context', { content: 'test content' }, 2000)
  expect(result.content).toBe('test content')
  expect(result.virtual).toBeFalse()
  expect(result.updated_at).toBeString()
})

test('updateExplicitSlot rejects virtual slots', () => {
  expect(() => updateExplicitSlot('persona', { content: 'test' }, 2000)).toThrow(ValidationError)
})

test('updateExplicitSlot validates max_chars range', () => {
  expect(() => updateExplicitSlot('project_context', { content: 'x', max_chars: 50 }, 2000)).toThrow(ValidationError)
  expect(() => updateExplicitSlot('project_context', { content: 'x', max_chars: 9000 }, 2000)).toThrow(ValidationError)
})

test('updateExplicitSlot truncates content to max_chars', () => {
  const result = updateExplicitSlot('active_goals', { content: 'x'.repeat(500), max_chars: 100 }, 2000)
  expect(result.content).toHaveLength(100)
  expect(result.truncated).toBeTrue()
})

test('updateExplicitSlot persists and re-reads', () => {
  updateExplicitSlot('project_context', { content: 'persisted' }, 2000)
  const slots = getSlots({ names: ['project_context'] })
  expect(slots[0].content).toBe('persisted')
})

test('updateExplicitSlot supports project scope', () => {
  const db = getDb()
  const projectId = 'test-project'
  db.prepare('INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(projectId, 'Test', new Date().toISOString())
  const result = updateExplicitSlot('project_context', { content: 'project scoped', scope: 'project', project_id: projectId }, 2000)
  expect(result.scope).toBe('project')
})

test('updateExplicitSlot rejects project scope without project_id', () => {
  expect(() => updateExplicitSlot('project_context', { content: 'x', scope: 'project' }, 2000)).toThrow(ValidationError)
})
