import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { getDb } from './container'
import { closeDb } from './init'
import { findExpiredArchivedThoughtIds } from './ttl-cleanup'

beforeEach(createTestDb)
afterEach(closeDb)

function insertArchived(daysAgo: number, protected_ = false): string {
  const db = getDb()
  const id = seedThought({ status: 'active', is_protected: protected_ ? 1 : 0 })
  const archivedAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString()
  db.prepare(`UPDATE thoughts SET status = 'archived', archived_at = ? WHERE id = ?`).run(archivedAt, id)
  return id
}

test('findExpiredArchivedThoughtIds returns empty when no archived thoughts', () => {
  seedThought({ status: 'active' })
  expect(findExpiredArchivedThoughtIds(getDb(), new Date().toISOString())).toEqual([])
})

test('findExpiredArchivedThoughtIds returns archived unprotected thoughts older than cutoff', () => {
  const oldId = insertArchived(100)
  const recentId = insertArchived(1)
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const ids = findExpiredArchivedThoughtIds(getDb(), cutoff)
  expect(ids).toContain(oldId)
  expect(ids).not.toContain(recentId)
})

test('findExpiredArchivedThoughtIds excludes protected thoughts', () => {
  const protectedId = insertArchived(100, true)
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()
  expect(findExpiredArchivedThoughtIds(getDb(), cutoff)).not.toContain(protectedId)
})

test('findExpiredArchivedThoughtIds excludes active thoughts', () => {
  const activeId = seedThought({ status: 'active' })
  const cutoff = new Date().toISOString()
  expect(findExpiredArchivedThoughtIds(getDb(), cutoff)).not.toContain(activeId)
})

test('findExpiredArchivedThoughtIds excludes thoughts without archived_at', () => {
  const db = getDb()
  const id = seedThought({ status: 'archived' })
  // No archived_at set — should not be returned
  expect(findExpiredArchivedThoughtIds(db, new Date().toISOString())).not.toContain(id)
})
