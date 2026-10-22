import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb, getDb } from '../db'
import { config } from '../config'
import { getSlots, updateExplicitSlot, SLOT_NAMES } from './slots.service'
import { ValidationError } from '../errors'

beforeEach(createTestDb)
afterEach(closeDb)

// ── getSlots ─────────────────────────────────────────────────────────────────

test('getSlots returns all 4 slot views', () => {
  const slots = getSlots()
  expect(slots).toHaveLength(4)
  expect(slots.map(s => s.name)).toEqual([...SLOT_NAMES])
})

test('getSlots virtual slots have virtual=true', () => {
  const slots = getSlots()
  const pending = slots.find(s => s.name === 'pending_items')
  expect(pending?.virtual).toBeTrue()
  expect(pending?.scope).toBe('global')
})

test('getSlots explicit slots have virtual=false', () => {
  const slots = getSlots()
  const projectCtx = slots.find(s => s.name === 'project_context')
  expect(projectCtx?.virtual).toBeFalse()
})

test('getSlots filters by names', () => {
  const slots = getSlots({ names: ['pending_items', 'active_goals'] })
  expect(slots).toHaveLength(2)
})

test('getSlots treats an unknown name as no slot (persona is not a slot anymore)', () => {
  expect(getSlots({ names: ['persona'] })).toHaveLength(0)
})

test('getSlots architecture_decisions content from primers', () => {
  const id = seedThought({ content: 'use SQLite for local storage' })
  const db = getDb()
  db.prepare('INSERT INTO primers (thought_id, hit_count, created_at) VALUES (?, ?, ?)').run(id, 5, new Date().toISOString())
  const slots = getSlots({ names: ['architecture_decisions'] })
  expect(slots[0].content).toContain('use SQLite for local storage')
})

test('getSlots architecture_decisions renders only the topN primers', () => {
  const original = config.primer.topN
  config.primer.topN = 2
  try {
    const db = getDb()
    const now = new Date().toISOString()
    const top = seedThought({ content: 'top hit decision' })
    const middle = seedThought({ content: 'middle hit decision' })
    const low = seedThought({ content: 'low hit decision' })
    const insert = db.prepare('INSERT INTO primers (thought_id, hit_count, created_at) VALUES (?, ?, ?)')
    insert.run(top, 30, now)
    insert.run(middle, 20, now)
    insert.run(low, 10, now)

    const slots = getSlots({ names: ['architecture_decisions'] })
    const bullets = slots[0].content.split('\n')
    expect(bullets).toHaveLength(2)
    expect(bullets[0]).toBe('- top hit decision')
    expect(bullets[1]).toBe('- middle hit decision')
    expect(slots[0].content).not.toContain('low hit decision')
  } finally {
    config.primer.topN = original
  }
})

// A negative topN reaches SQLite as `LIMIT -1`, which means "no limit": the
// slot would render EVERY primer instead of the top N. The configured topN is
// clamped at the slot, so a negative one renders a single primer.
//
// The whole `config.primer` section is swapped (not `config.primer.topN`
// patched in place): with an empty config.json the merged config shares the
// DEFAULTS object, so an in-place patch would poison the defaults the slot
// falls back to — and the case would measure the wrong thing.
test('getSlots architecture_decisions renders ONE bullet when the configured topN is negative', () => {
  const original = config.primer
  config.primer = { ...original, topN: -1 }
  try {
    const db = getDb()
    const now = new Date().toISOString()
    const top = seedThought({ content: 'top hit decision' })
    const middle = seedThought({ content: 'middle hit decision' })
    const low = seedThought({ content: 'low hit decision' })
    const insert = db.prepare('INSERT INTO primers (thought_id, hit_count, created_at) VALUES (?, ?, ?)')
    insert.run(top, 30, now)
    insert.run(middle, 20, now)
    insert.run(low, 10, now)

    const slots = getSlots({ names: ['architecture_decisions'] })
    const bullets = slots[0].content.split('\n')
    expect(bullets).toHaveLength(1)
    expect(bullets[0]).toBe('- top hit decision')
    expect(slots[0].content).not.toContain('middle hit decision')
    expect(slots[0].content).not.toContain('low hit decision')
  } finally {
    config.primer = original
  }
})

test('getSlots architecture_decisions renders ONE bullet when the configured topN is zero', () => {
  const original = config.primer
  config.primer = { ...original, topN: 0 }
  try {
    const db = getDb()
    const now = new Date().toISOString()
    const top = seedThought({ content: 'top hit decision' })
    const low = seedThought({ content: 'low hit decision' })
    const insert = db.prepare('INSERT INTO primers (thought_id, hit_count, created_at) VALUES (?, ?, ?)')
    insert.run(top, 30, now)
    insert.run(low, 10, now)

    const slots = getSlots({ names: ['architecture_decisions'] })
    // The exact content, not just the bullet count: an EMPTY slot also splits
    // into one element, and "no primer at all" is not the contract.
    expect(slots[0].content).toBe('- top hit decision')
    expect(slots[0].content.split('\n')).toHaveLength(1)
  } finally {
    config.primer = original
  }
})

// A non-numeric topN falls back to the built-in default (3) at the slot: the
// db layer's own fallback is its page size (500), so without the slot's clamp
// the whole primer set would be rendered.
test('getSlots architecture_decisions renders the default 3 bullets when the configured topN is not a number', () => {
  const original = config.primer
  config.primer = { ...original, topN: Number.NaN }
  try {
    const db = getDb()
    const now = new Date().toISOString()
    const insert = db.prepare('INSERT INTO primers (thought_id, hit_count, created_at) VALUES (?, ?, ?)')
    for (const [content, hits] of [['one', 50], ['two', 40], ['three', 30], ['four', 20], ['five', 10]] as const) {
      insert.run(seedThought({ content }), hits, now)
    }

    const slots = getSlots({ names: ['architecture_decisions'] })
    expect(slots[0].content.split('\n')).toHaveLength(3)
  } finally {
    config.primer = original
  }
})

// ── updateExplicitSlot ───────────────────────────────────────────────────────

test('updateExplicitSlot updates project_context', () => {
  const result = updateExplicitSlot('project_context', { content: 'test content' }, 2000)
  expect(result.content).toBe('test content')
  expect(result.virtual).toBeFalse()
  expect(result.updated_at).toBeString()
})

test('updateExplicitSlot rejects virtual slots', () => {
  expect(() => updateExplicitSlot('pending_items', { content: 'test' }, 2000)).toThrow(ValidationError)
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

test('getSlots pending_items slot is empty when no pending thoughts', () => {
  const slots = getSlots({ names: ['pending_items'] })
  expect(slots).toHaveLength(1)
  expect(slots[0]!.content).toBe('')
})

test('getSlots pending_items slot surfaces due pending thoughts', () => {
  const past = new Date(Date.now() - 86_400_000).toISOString()
  seedThought({ content: 'wake me up', status: 'draft', tags: '["pending"]', surface_after: past })
  const slots = getSlots({ names: ['pending_items'] })
  expect(slots).toHaveLength(1)
  expect(slots[0]!.content).toContain('wake me up')
})

test('getSlots pending_items slot omits not-yet-due pending thoughts', () => {
  const future = new Date(Date.now() + 7 * 86_400_000).toISOString()
  seedThought({ content: 'not yet', status: 'draft', tags: '["pending"]', surface_after: future })
  const slots = getSlots({ names: ['pending_items'] })
  expect(slots).toHaveLength(1)
  expect(slots[0]!.content).toBe('')
})

test('getSlots pending_items slot is virtual', () => {
  const slots = getSlots({ names: ['pending_items'] })
  expect(slots).toHaveLength(1)
  expect(slots[0]!.virtual).toBeTrue()
  expect(slots[0]!.scope).toBe('global')
})
