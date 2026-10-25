import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { getDb } from './container'
import { closeDb } from './init'

beforeEach(createTestDb)
afterEach(closeDb)

test('concurrent reversed edge insert is impossible at DB level', () => {
  const db = getDb()
  const a = seedThought()
  const b = seedThought()
  db.prepare(`INSERT INTO edges (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    crypto.randomUUID(), a, b, 'related', new Date().toISOString(),
  )
  expect(() => {
    db.prepare(`INSERT INTO edges (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      crypto.randomUUID(), b, a, 'develops', new Date().toISOString(),
    )
  }).toThrow()
})

test('reversed edge insert throws even for identical type', () => {
  const db = getDb()
  const a = seedThought()
  const b = seedThought()
  db.prepare(`INSERT INTO edges (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    crypto.randomUUID(), a, b, 'develops', new Date().toISOString(),
  )
  expect(() => {
    db.prepare(`INSERT INTO edges (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      crypto.randomUUID(), b, a, 'develops', new Date().toISOString(),
    )
  }).toThrow()
})

test('content dedupe enforced by partial unique index (draft)', () => {
  const db = getDb()
  const projectId = (db.prepare(`SELECT project_id FROM thoughts LIMIT 1`).get() as { project_id: string } | undefined)?.project_id ?? 'default'
  const hash = 'deadbeef-draft'
  db.prepare(`INSERT INTO thoughts (id, content, status, project_id, content_hash, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?, ?, ?)`).run(
    crypto.randomUUID(), 'c1', projectId, hash, new Date().toISOString(), new Date().toISOString(),
  )
  expect(() => {
    db.prepare(`INSERT INTO thoughts (id, content, status, project_id, content_hash, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?, ?, ?)`).run(
      crypto.randomUUID(), 'c2', projectId, hash, new Date().toISOString(), new Date().toISOString(),
    )
  }).toThrow()
})

test('content dedupe enforced by partial unique index (active)', () => {
  const db = getDb()
  const projectId = (db.prepare(`SELECT project_id FROM thoughts LIMIT 1`).get() as { project_id: string } | undefined)?.project_id ?? 'default'
  const hash = 'deadbeef-active'
  db.prepare(`INSERT INTO thoughts (id, content, status, project_id, content_hash, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?, ?)`).run(
    crypto.randomUUID(), 'c1', projectId, hash, new Date().toISOString(), new Date().toISOString(),
  )
  expect(() => {
    db.prepare(`INSERT INTO thoughts (id, content, status, project_id, content_hash, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?, ?)`).run(
      crypto.randomUUID(), 'c2', projectId, hash, new Date().toISOString(), new Date().toISOString(),
    )
  }).toThrow()
})

test('content dedupe allows archived duplicates', () => {
  const db = getDb()
  const projectId = (db.prepare(`SELECT project_id FROM thoughts LIMIT 1`).get() as { project_id: string } | undefined)?.project_id ?? 'default'
  const hash = 'deadbeef-archived'
  db.prepare(`INSERT INTO thoughts (id, content, status, project_id, content_hash, created_at, updated_at) VALUES (?, ?, 'archived', ?, ?, ?, ?)`).run(
    crypto.randomUUID(), 'c1', projectId, hash, new Date().toISOString(), new Date().toISOString(),
  )
  expect(() => {
    db.prepare(`INSERT INTO thoughts (id, content, status, project_id, content_hash, created_at, updated_at) VALUES (?, ?, 'archived', ?, ?, ?, ?)`).run(
      crypto.randomUUID(), 'c2', projectId, hash, new Date().toISOString(), new Date().toISOString(),
    )
  }).not.toThrow()
})

test('content dedupe allows different projects', () => {
  const db = getDb()
  const hash = 'deadbeef-project'
  db.prepare(`INSERT INTO thoughts (id, content, status, project_id, content_hash, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?, ?, ?)`).run(
    crypto.randomUUID(), 'c1', 'p-a', hash, new Date().toISOString(), new Date().toISOString(),
  )
  expect(() => {
    db.prepare(`INSERT INTO thoughts (id, content, status, project_id, content_hash, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?, ?, ?)`).run(
      crypto.randomUUID(), 'c2', 'p-b', hash, new Date().toISOString(), new Date().toISOString(),
    )
  }).not.toThrow()
})

test('content dedupe allows null content_hash duplicates', () => {
  const db = getDb()
  const projectId = (db.prepare(`SELECT project_id FROM thoughts LIMIT 1`).get() as { project_id: string } | undefined)?.project_id ?? 'default'
  db.prepare(`INSERT INTO thoughts (id, content, status, project_id, content_hash, created_at, updated_at) VALUES (?, ?, 'draft', ?, NULL, ?, ?)`).run(
    crypto.randomUUID(), 'c1', projectId, new Date().toISOString(), new Date().toISOString(),
  )
  expect(() => {
    db.prepare(`INSERT INTO thoughts (id, content, status, project_id, content_hash, created_at, updated_at) VALUES (?, ?, 'draft', ?, NULL, ?, ?)`).run(
      crypto.randomUUID(), 'c2', projectId, new Date().toISOString(), new Date().toISOString(),
    )
  }).not.toThrow()
})
