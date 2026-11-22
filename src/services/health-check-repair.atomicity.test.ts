import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../db'
import { closeDb } from '../db/init'
import { createTestDb, seedThought } from '../test/helpers'
import { runHealthRepairService } from './health-check-repair.service'

beforeEach(createTestDb)
afterEach(closeDb)

function count(sql: string, ...args: string[]): number {
  const row = getDb()
    .prepare(sql)
    .get(...args) as { n: number } | undefined
  return row?.n ?? 0
}

/**
 * Two auto-fixable findings in repair order: an orphan edge (structural_integrity, repaired first)
 * and an empty cluster (cluster_health, repaired second) — so the cluster trigger below aborts the
 * run only after the edge fix has already written.
 */
function seedRepairable(): { edgeId: string; clusterId: string; danglingSource: string } {
  const db = getDb()
  const danglingSource = seedThought({ content: 'dangling edge source' })
  const target = seedThought({ content: 'dangling edge target' })
  const edgeId = crypto.randomUUID()
  db.prepare(
    'INSERT INTO edges (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(edgeId, danglingSource, target, 'related', new Date().toISOString())
  db.run('PRAGMA foreign_keys = OFF')
  db.prepare('DELETE FROM thoughts WHERE id = ?').run(danglingSource)
  db.run('PRAGMA foreign_keys = ON')
  const clusterId = seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })
  return { edgeId, clusterId, danglingSource }
}

function blockClusterArchive(clusterId: string): void {
  getDb().run(
    `CREATE TRIGGER probe_block_repair BEFORE UPDATE OF status ON thoughts
     WHEN OLD.id = '${clusterId}' AND NEW.status = 'archived'
     BEGIN SELECT RAISE(ABORT, 'probe: repair blocked'); END`
  )
}

function edgeExists(edgeId: string): boolean {
  return count('SELECT COUNT(*) AS n FROM edges WHERE id = ?', edgeId) === 1
}

function statusOf(id: string): string | undefined {
  const row = getDb().prepare('SELECT status FROM thoughts WHERE id = ?').get(id) as
    | { status: string }
    | undefined
  return row?.status
}

test('a mid-loop repair failure leaves the data and the preview token untouched', () => {
  const { edgeId, clusterId } = seedRepairable()
  blockClusterArchive(clusterId)

  const preview = runHealthRepairService()
  expect(preview.status).toBe('preview')
  expect(preview.repairable?.map(item => item.name)).toEqual(['orphan_edges', 'empty_clusters'])

  expect(() =>
    runHealthRepairService({ confirm: true, preview_token: preview.preview_token })
  ).toThrow('probe: repair blocked')

  expect(edgeExists(edgeId)).toBe(true)
  expect(statusOf(clusterId)).toBe('active')
  expect(count('SELECT COUNT(*) AS n FROM preview_tokens')).toBe(1)
})

test('the same token then applies the whole repair and is spent exactly once', () => {
  const { edgeId, clusterId } = seedRepairable()
  blockClusterArchive(clusterId)

  const preview = runHealthRepairService()
  expect(() =>
    runHealthRepairService({ confirm: true, preview_token: preview.preview_token })
  ).toThrow('probe: repair blocked')

  getDb().run('DROP TRIGGER probe_block_repair')
  const executed = runHealthRepairService({ confirm: true, preview_token: preview.preview_token })

  expect(executed.status).toBe('executed')
  expect(executed.repaired?.map(item => item.name)).toEqual(['orphan_edges', 'empty_clusters'])
  expect(edgeExists(edgeId)).toBe(false)
  expect(statusOf(clusterId)).toBe('archived')
  expect(count('SELECT COUNT(*) AS n FROM preview_tokens')).toBe(0)

  expect(() =>
    runHealthRepairService({ confirm: true, preview_token: preview.preview_token })
  ).toThrow('preview token not_found')
})
