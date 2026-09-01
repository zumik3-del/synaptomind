import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb } from '../test/helpers'
import { closeDb, getDb } from '../db'
import { reflectSession } from './session-reflection.service'
import { ValidationError, NotFoundError } from './errors'

beforeEach(createTestDb)
afterEach(closeDb)

test('reflectSession throws when nothing provided', () => {
  expect(() => reflectSession({})).toThrow(ValidationError)
})

test('reflectSession appends summary to project_context', () => {
  const result = reflectSession({ summary: 'Session went well' })
  expect(result.summary_appended).toBeTrue()
  const db = getDb()
  const row = db.prepare("SELECT content FROM slots WHERE name = 'project_context' AND scope = 'global'").get() as { content: string }
  expect(row.content).toContain('Session went well')
})

test('reflectSession adds goals', () => {
  const result = reflectSession({ goals_delta: ['Goal A', 'Goal B'] })
  expect(result.goals_added).toBe(2)
  const db = getDb()
  const row = db.prepare("SELECT content FROM slots WHERE name = 'active_goals'").get() as { content: string }
  expect(row.content).toContain('Goal A')
  expect(row.content).toContain('Goal B')
})

test('reflectSession removes goals with closed: prefix', () => {
  reflectSession({ goals_delta: ['Goal A', 'Goal B'] })
  const result = reflectSession({ goals_delta: ['closed: Goal A'] })
  expect(result.goals_removed).toBe(1)
  expect(result.goals_added).toBe(0)
})

test('reflectSession deduplicates goals', () => {
  reflectSession({ goals_delta: ['Goal A'] })
  const result = reflectSession({ goals_delta: ['Goal A'] })
  expect(result.goals_added).toBe(0)
})

test('reflectSession creates decision thoughts', () => {
  const result = reflectSession({ decisions: ['Use SQLite', 'Keep it simple'] })
  expect(result.decisions_created).toBe(2)
  const db = getDb()
  const thoughts = db.prepare("SELECT t.id, t.content FROM thoughts t WHERE t.source = 'session-reflection'").all() as { id: string; content: string }[]
  expect(thoughts.length).toBe(2)
  // Check that each decision thought has the 'decision' tag
  for (const t of thoughts) {
    const tag = db.prepare("SELECT 1 FROM thought_tags tt JOIN tags tg ON tt.tag_id = tg.id WHERE tt.thought_id = ? AND tg.name = 'decision'").get(t.id)
    expect(tag).toBeDefined()
  }
})

test('reflectSession creates pending thoughts with smart notes', () => {
  const result = reflectSession({ pending: ['Write tests'] })
  expect(result.pending_created).toBe(1)
  const db = getDb()
  const thought = db.prepare("SELECT id FROM thoughts WHERE source = 'session-reflection'").get() as { id: string }
  const note = db.prepare('SELECT * FROM smart_notes WHERE thought_id = ?').get(thought.id)
  expect(note).toBeDefined()
})

test('reflectSession validates summary is non-empty string', () => {
  expect(() => reflectSession({ summary: '' })).toThrow(ValidationError)
  expect(() => reflectSession({ summary: '   ' })).toThrow(ValidationError)
})

test('reflectSession validates goals_delta entries', () => {
  expect(() => reflectSession({ goals_delta: [''] })).toThrow(ValidationError)
  expect(() => reflectSession({ goals_delta: ['  '] })).toThrow(ValidationError)
})

test('reflectSession validates wake_days range', () => {
  expect(() => reflectSession({ pending: ['task'], wake_days: 0 })).toThrow(ValidationError)
  expect(() => reflectSession({ pending: ['task'], wake_days: 400 })).toThrow(ValidationError)
})

test('reflectSession validates project exists when project_id given', () => {
  expect(() => reflectSession({ summary: 'test', project_id: 'nonexistent' })).toThrow(NotFoundError)
})

test('reflectSession works with project scope', () => {
  const db = getDb()
  db.prepare('INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('proj-1', 'Test', new Date().toISOString())
  const result = reflectSession({ summary: 'project update', project_id: 'proj-1' })
  expect(result.summary_appended).toBeTrue()
  const row = db.prepare("SELECT content FROM slots WHERE name = 'project_context' AND scope = 'project' AND scope_id = 'proj-1'").get() as { content: string }
  expect(row.content).toContain('project update')
})

test('reflectSession combines multiple inputs in one call', () => {
  const result = reflectSession({
    summary: 'did stuff',
    goals_delta: ['new goal'],
    decisions: ['made a call'],
    pending: ['todo item']
  })
  expect(result.summary_appended).toBeTrue()
  expect(result.goals_added).toBe(1)
  expect(result.decisions_created).toBe(1)
  expect(result.pending_created).toBe(1)
})
