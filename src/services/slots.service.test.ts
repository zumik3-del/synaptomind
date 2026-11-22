import { afterEach, beforeEach, expect, test } from 'bun:test'
import { configFixture, createTestDb, seedThought } from '../test/helpers'
import { closeDb, getDb } from '../db'
import { config } from '../config'
import { getSlots, SLOT_NAMES } from './slots.service'

beforeEach(createTestDb)
afterEach(closeDb)

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
  db.prepare('INSERT INTO primers (thought_id, hit_count, created_at) VALUES (?, ?, ?)').run(
    id,
    5,
    new Date().toISOString()
  )
  const slots = getSlots({ names: ['architecture_decisions'] })
  expect(slots[0].content).toContain('use SQLite for local storage')
})

test('getSlots architecture_decisions renders only the topN primers', () => {
  const cfg = configFixture({ primer: { ...config.primer, topN: 2 } })
  const db = getDb()
  const now = new Date().toISOString()
  const top = seedThought({ content: 'top hit decision' })
  const middle = seedThought({ content: 'middle hit decision' })
  const low = seedThought({ content: 'low hit decision' })
  const insert = db.prepare(
    'INSERT INTO primers (thought_id, hit_count, created_at) VALUES (?, ?, ?)'
  )
  insert.run(top, 30, now)
  insert.run(middle, 20, now)
  insert.run(low, 10, now)

  const slots = getSlots({ names: ['architecture_decisions'] }, undefined, cfg)
  const bullets = slots[0].content.split('\n')
  expect(bullets).toHaveLength(2)
  expect(bullets[0]).toBe('- top hit decision')
  expect(bullets[1]).toBe('- middle hit decision')
  expect(slots[0].content).not.toContain('low hit decision')
})

// The whole `primer` section is replaced in the fixture: the loaded config is frozen and shares its
// untouched sections with DEFAULTS, so the case measures the value it declares and nothing else.
test('getSlots architecture_decisions renders ONE bullet when the configured topN is negative', () => {
  const cfg = configFixture({ primer: { ...config.primer, topN: -1 } })
  const db = getDb()
  const now = new Date().toISOString()
  const top = seedThought({ content: 'top hit decision' })
  const middle = seedThought({ content: 'middle hit decision' })
  const low = seedThought({ content: 'low hit decision' })
  const insert = db.prepare(
    'INSERT INTO primers (thought_id, hit_count, created_at) VALUES (?, ?, ?)'
  )
  insert.run(top, 30, now)
  insert.run(middle, 20, now)
  insert.run(low, 10, now)

  const slots = getSlots({ names: ['architecture_decisions'] }, undefined, cfg)
  const bullets = slots[0].content.split('\n')
  expect(bullets).toHaveLength(1)
  expect(bullets[0]).toBe('- top hit decision')
  expect(slots[0].content).not.toContain('middle hit decision')
  expect(slots[0].content).not.toContain('low hit decision')
})

test('getSlots architecture_decisions renders ONE bullet when the configured topN is zero', () => {
  const cfg = configFixture({ primer: { ...config.primer, topN: 0 } })
  const db = getDb()
  const now = new Date().toISOString()
  const top = seedThought({ content: 'top hit decision' })
  const low = seedThought({ content: 'low hit decision' })
  const insert = db.prepare(
    'INSERT INTO primers (thought_id, hit_count, created_at) VALUES (?, ?, ?)'
  )
  insert.run(top, 30, now)
  insert.run(low, 10, now)

  const slots = getSlots({ names: ['architecture_decisions'] }, undefined, cfg)
  // The exact content, not just the bullet count: an EMPTY slot also splits
  // into one element, and "no primer at all" is not the contract.
  expect(slots[0].content).toBe('- top hit decision')
  expect(slots[0].content.split('\n')).toHaveLength(1)
})

test('getSlots architecture_decisions renders the default 3 bullets when the configured topN is not a number', () => {
  const cfg = configFixture({ primer: { ...config.primer, topN: Number.NaN } })
  const db = getDb()
  const now = new Date().toISOString()
  const insert = db.prepare(
    'INSERT INTO primers (thought_id, hit_count, created_at) VALUES (?, ?, ?)'
  )
  for (const [content, hits] of [
    ['one', 50],
    ['two', 40],
    ['three', 30],
    ['four', 20],
    ['five', 10]
  ] as const) {
    insert.run(seedThought({ content }), hits, now)
  }

  const slots = getSlots({ names: ['architecture_decisions'] }, undefined, cfg)
  expect(slots[0].content.split('\n')).toHaveLength(3)
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
