import { beforeEach, afterEach, expect, test, describe } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb, getDb } from '../db'
import { cleanupArchivedThoughts } from './ttl-cleanup.service'

beforeEach(createTestDb)
afterEach(() => { closeDb() })

function insertArchived(archivedAtAgo: number): string {
  const d = getDb()
  const id = seedThought({ status: 'active', is_protected: 0 })
  const archivedAt = new Date(Date.now() - archivedAtAgo).toISOString()
  d.prepare(`UPDATE thoughts SET status = 'archived', archived_at = ? WHERE id = ?`).run(archivedAt, id)
  return id
}

describe('cleanupArchivedThoughts', () => {
  test('deletes archived thoughts older than TTL', () => {
    const id = insertArchived(100 * 86400000) // 100 days ago
    const result = cleanupArchivedThoughts()
    expect(result.deleted).toBe(1)
    expect(result.ids).toContain(id)
    const d = getDb()
    const row = d.prepare(`SELECT id FROM thoughts WHERE id = ?`).get(id)
    expect(row == null).toBe(true)
  })

  test('keeps archived thoughts within TTL', () => {
    const id = insertArchived(10 * 86400000) // 10 days ago
    const result = cleanupArchivedThoughts()
    expect(result.deleted).toBe(0)
    expect(result.ids).not.toContain(id)
    const d = getDb()
    const row = d.prepare(`SELECT id FROM thoughts WHERE id = ?`).get(id)
    expect(row != null).toBe(true)
  })

  test('keeps active thoughts', () => {
    seedThought({ status: 'active' })
    const result = cleanupArchivedThoughts()
    expect(result.deleted).toBe(0)
  })

  test('dry_run returns count without deleting', () => {
    const id = insertArchived(100 * 86400000)
    const result = cleanupArchivedThoughts(true)
    expect(result.deleted).toBe(1)
    expect(result.ids).toContain(id)
    const d = getDb()
    const row = d.prepare(`SELECT id FROM thoughts WHERE id = ?`).get(id)
    expect(row != null).toBe(true)
  })

  test('handles mixed old and new archived thoughts', () => {
    const old = insertArchived(200 * 86400000)
    const recent = insertArchived(5 * 86400000)
    const result = cleanupArchivedThoughts()
    expect(result.deleted).toBe(1)
    expect(result.ids).toContain(old)
    expect(result.ids).not.toContain(recent)
    const d = getDb()
    expect(d.prepare(`SELECT id FROM thoughts WHERE id = ?`).get(old) == null).toBe(true)
    expect(d.prepare(`SELECT id FROM thoughts WHERE id = ?`).get(recent) != null).toBe(true)
  })

  test('deletes cascade edges via ON DELETE CASCADE', () => {
    const old = insertArchived(100 * 86400000)
    const active = seedThought({ status: 'active' })
    const d = getDb()
    const edgeId = 'test-edge'
    d.prepare(`INSERT INTO edges (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, 'related', ?)`).run(
      edgeId, old, active, new Date().toISOString()
    )
    cleanupArchivedThoughts()
    const edge = d.prepare(`SELECT id FROM edges WHERE id = ?`).get(edgeId)
    expect(edge == null).toBe(true)
  })

  test('returns empty when no archived thoughts exist', () => {
    seedThought({ status: 'active' })
    const result = cleanupArchivedThoughts()
    expect(result.deleted).toBe(0)
    expect(result.ids).toHaveLength(0)
  })
})
