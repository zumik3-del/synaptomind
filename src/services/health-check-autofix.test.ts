/**
 * Regression tests for audit-fix task #849 (health-check auto-fix OCP).
 *
 * #849 — CheckDef now carries an optional `autofix` hook; presence marks the
 * check as auto-fixable. runAutoFix calls the hook instead of switching on
 * check.name. Verifies:
 *   1. Checks with an autofix hook report auto_fixable=true.
 *   2. Checks without an autofix hook report auto_fixable=undefined.
 *   3. broken_parent_chains autofix only deletes edges to archived targets.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../db'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { runHealthCheck } from './health-check.service'

beforeEach(createTestDb)
afterEach(() => {
  const { closeDb } = require('../db/init')
  closeDb()
})

test('checks with autofix hook report auto_fixable=true', () => {
  // Seed an orphan edge so the orphan_edges check fires.
  const a = seedThought({ content: 'A' })
  const b = seedThought({ content: 'B' })
  const db = getDb()
  const edgeId = crypto.randomUUID()
  db.prepare('INSERT INTO edges (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, ?, ?)').run(edgeId, a, b, 'related', new Date().toISOString())
  db.run('PRAGMA foreign_keys = OFF')
  db.prepare('DELETE FROM thoughts WHERE id = ?').run(a)
  db.run('PRAGMA foreign_keys = ON')

  const report = runHealthCheck()
  const structural = report.categories.find(c => c.name === 'structural_integrity')!
  const orphanCheck = structural.checks.find(c => c.name === 'orphan_edges')!
  expect(orphanCheck.auto_fixable).toBe(true)
})

test('checks without autofix hook report auto_fixable undefined', () => {
  // duplicate_edges has no autofix hook.
  const report = runHealthCheck()
  const structural = report.categories.find(c => c.name === 'structural_integrity')!
  const dupCheck = structural.checks.find(c => c.name === 'duplicate_edges')!
  expect(dupCheck.auto_fixable).toBeUndefined()
})

test('broken_parent_chains autofix only deletes edges to archived targets', () => {
  const parent = seedThought({ content: 'active parent' })
  const archivedChild = seedThought({ content: 'archived child', status: 'archived' })
  const draftChild = seedThought({ content: 'draft child', status: 'draft' })
  seedEdge(parent, archivedChild, 'parent')
  seedEdge(parent, draftChild, 'parent')

  // Verify both edges exist before fix.
  const before = getDb().prepare("SELECT target_id FROM edges WHERE type = 'parent'").all() as Array<{ target_id: string }>
  expect(before.map(r => r.target_id).sort()).toEqual([archivedChild, draftChild].sort())

  runHealthCheck({ fix: true })

  const remaining = getDb()
    .prepare("SELECT target_id FROM edges WHERE type = 'parent'")
    .all() as Array<{ target_id: string }>
  // Only the draft-target edge survives; archived-target edge is removed.
  expect(remaining.map(r => r.target_id)).toEqual([draftChild])
})

test('empty_cluster autofix removes the empty cluster thought', () => {
  const clusterId = seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })

  const before = runHealthCheck()
  const clusterCat = before.categories.find(c => c.name === 'cluster_health')!
  const empty = clusterCat.checks.find(c => c.name === 'empty_clusters')!
  expect(empty.count).toBe(1)
  expect(empty.auto_fixable).toBe(true)

  runHealthCheck({ fix: true })

  const db = getDb()
  const stillExists = db.prepare('SELECT 1 FROM thoughts WHERE id = ?').get(clusterId)
  expect(stillExists).toBeNull()
})

test('orphan_edge autofix removes the dangling edge', () => {
  const a = seedThought({ content: 'A' })
  const b = seedThought({ content: 'B' })
  const db = getDb()
  const edgeId = crypto.randomUUID()
  db.prepare('INSERT INTO edges (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, ?, ?)').run(edgeId, a, b, 'related', new Date().toISOString())
  db.run('PRAGMA foreign_keys = OFF')
  db.prepare('DELETE FROM thoughts WHERE id = ?').run(a)
  db.run('PRAGMA foreign_keys = ON')

  const before = runHealthCheck()
  const structural = before.categories.find(c => c.name === 'structural_integrity')!
  const orphan = structural.checks.find(c => c.name === 'orphan_edges')!
  expect(orphan.count).toBe(1)
  expect(orphan.auto_fixable).toBe(true)

  runHealthCheck({ fix: true })

  const remaining = db.prepare('SELECT 1 FROM edges WHERE id = ?').get(edgeId)
  expect(remaining).toBeNull()
})
