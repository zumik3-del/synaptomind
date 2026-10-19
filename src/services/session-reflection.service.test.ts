import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb } from '../test/helpers'
import { closeDb, getDb } from '../db'
import { reflectSessionService } from './session-reflection.service'
import { ValidationError, NotFoundError } from '../errors'

beforeEach(createTestDb)
afterEach(closeDb)

test('reflectSessionService throws when nothing provided', () => {
  expect(() => reflectSessionService({})).toThrow(ValidationError)
})

test('reflectSessionService appends summary to project_context', () => {
  const result = reflectSessionService({ summary: 'Session went well' })
  expect(result.summary_appended).toBeTrue()
  const db = getDb()
  const row = db.prepare("SELECT content FROM slots WHERE name = 'project_context' AND scope = 'global'").get() as { content: string }
  expect(row.content).toContain('Session went well')
})

test('reflectSessionService adds goals', () => {
  const result = reflectSessionService({ goals_delta: ['Goal A', 'Goal B'] })
  expect(result.goals_added).toBe(2)
  const db = getDb()
  const row = db.prepare("SELECT content FROM slots WHERE name = 'active_goals'").get() as { content: string }
  expect(row.content).toContain('Goal A')
  expect(row.content).toContain('Goal B')
})

test('reflectSessionService removes goals with closed: prefix', () => {
  reflectSessionService({ goals_delta: ['Goal A', 'Goal B'] })
  const result = reflectSessionService({ goals_delta: ['closed: Goal A'] })
  expect(result.goals_removed).toBe(1)
  expect(result.goals_added).toBe(0)
})

test('reflectSessionService deduplicates goals', () => {
  reflectSessionService({ goals_delta: ['Goal A'] })
  const result = reflectSessionService({ goals_delta: ['Goal A'] })
  expect(result.goals_added).toBe(0)
})

test('reflectSessionService deduplicates identical decisions across sessions', () => {
  reflectSessionService({ decisions: ['Use SQLite for storage'] })
  const result = reflectSessionService({ decisions: ['Use SQLite for storage'] })
  expect(result.decisions_created).toBe(0)
})

test('reflectSessionService deduplicates similar decisions via Jaccard', () => {
  reflectSessionService({ decisions: ['We decided to use SQLite'] })
  const result = reflectSessionService({ decisions: ['We have decided to use sqlite'] })
  expect(result.decisions_created).toBe(0)
})

test('reflectSessionService creates new decision when sufficiently different', () => {
  reflectSessionService({ decisions: ['Use SQLite for storage'] })
  const result = reflectSessionService({ decisions: ['Use PostgreSQL instead'] })
  expect(result.decisions_created).toBe(1)
})

test('reflectSessionService skips archived decisions when checking dedup', () => {
  const db = getDb()
  // Create an archived decision manually
  const thoughtId = crypto.randomUUID()
  db.prepare("INSERT INTO thoughts (id, content, status, source, project_id, is_cluster, is_profile, is_protected, created_at, updated_at) VALUES (?, ?, 'archived', 'session-reflection', 'default', 0, 0, 1, ?, ?)").run(
    thoughtId,
    'Use SQLite for storage',
    new Date().toISOString(),
    new Date().toISOString()
  )
  const tagId = db.prepare("SELECT id FROM tags WHERE name = 'decision'").get() as { id: string }
  db.prepare("INSERT OR IGNORE INTO thought_tags (thought_id, tag_id) VALUES (?, ?)").run(thoughtId, tagId)

  const result = reflectSessionService({ decisions: ['Use SQLite for storage'] })
  expect(result.decisions_created).toBe(1)
})

test('reflectSessionService creates decision thoughts', () => {
  const result = reflectSessionService({ decisions: ['Use SQLite', 'Keep it simple'] })
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

test('reflectSessionService creates pending thoughts with a surface delay', () => {
  const result = reflectSessionService({ pending: ['Write tests'], wake_days: 3 })
  expect(result.pending_created).toBe(1)
  const db = getDb()
  const thought = db.prepare("SELECT status, surface_after FROM thoughts WHERE source = 'session-reflection'").get() as {
    status: string
    surface_after: string | null
  }
  expect(thought.status).toBe('draft')
  expect(thought.surface_after).not.toBeNull()
})

test('reflectSessionService validates summary is non-empty string', () => {
  expect(() => reflectSessionService({ summary: '' })).toThrow(ValidationError)
  expect(() => reflectSessionService({ summary: '   ' })).toThrow(ValidationError)
})

test('reflectSessionService validates goals_delta entries', () => {
  expect(() => reflectSessionService({ goals_delta: [''] })).toThrow(ValidationError)
  expect(() => reflectSessionService({ goals_delta: ['  '] })).toThrow(ValidationError)
})

test('reflectSessionService validates wake_days range', () => {
  expect(() => reflectSessionService({ pending: ['task'], wake_days: 0 })).toThrow(ValidationError)
  expect(() => reflectSessionService({ pending: ['task'], wake_days: 400 })).toThrow(ValidationError)
})

test('reflectSessionService validates project exists when project_id given', () => {
  expect(() => reflectSessionService({ summary: 'test', project_id: 'nonexistent' })).toThrow(NotFoundError)
})

test('reflectSessionService works with project scope', () => {
  const db = getDb()
  db.prepare('INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('proj-1', 'Test', new Date().toISOString())
  const result = reflectSessionService({ summary: 'project update', project_id: 'proj-1' })
  expect(result.summary_appended).toBeTrue()
  const row = db.prepare("SELECT content FROM slots WHERE name = 'project_context' AND scope = 'project' AND scope_id = 'proj-1'").get() as { content: string }
  expect(row.content).toContain('project update')
})

test('reflectSessionService combines multiple inputs in one call', () => {
  const result = reflectSessionService({
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
