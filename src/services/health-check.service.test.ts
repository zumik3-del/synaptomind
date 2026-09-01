import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../db'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { runHealthCheck } from './health-check.service'

beforeEach(createTestDb)
afterEach(() => {
  const { closeDb } = require('../db/init')
  closeDb()
})

test('runHealthCheck returns valid structure on empty DB', () => {
  const report = runHealthCheck()
  expect(report.summary.total_thoughts).toBe(0)
  expect(report.summary.total_edges).toBe(0)
  expect(report.summary.health_score).toBe(100)
  expect(report.categories.length).toBe(6)
})

test('detects orphan edges', () => {
  const a = seedThought({ content: 'thought A' })
  const b = seedThought({ content: 'thought B' })

  // Insert edge directly to avoid FK, then delete thought
  const db = getDb()
  const edgeId = crypto.randomUUID()
  db.prepare('INSERT INTO edges (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, ?, ?)').run(edgeId, a, b, 'related', new Date().toISOString())
  // Disable FK temporarily to allow orphan
  db.run('PRAGMA foreign_keys = OFF')
  db.prepare('DELETE FROM thoughts WHERE id = ?').run(a)
  db.run('PRAGMA foreign_keys = ON')

  const report = runHealthCheck()
  const structural = report.categories.find(c => c.name === 'structural_integrity')
  const orphan = structural!.checks.find(c => c.name === 'orphan_edges')
  expect(orphan!.count).toBe(1)
  expect(orphan!.severity).toBe('critical')
})

test('detects self-loop edges', () => {
  const a = seedThought({ content: 'self loop' })
  const db = getDb()
  const id = crypto.randomUUID()
  db.prepare('INSERT INTO edges (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, ?, ?)').run(id, a, a, 'related', new Date().toISOString())

  const report = runHealthCheck()
  const structural = report.categories.find(c => c.name === 'structural_integrity')
  const selfLoop = structural!.checks.find(c => c.name === 'self_loop_edges')
  expect(selfLoop!.count).toBe(1)
  expect(selfLoop!.severity).toBe('critical')
})

test('detects empty clusters', () => {
  seedThought({ content: 'empty cluster', is_cluster: 1 })

  const report = runHealthCheck()
  const clusterCat = report.categories.find(c => c.name === 'cluster_health')
  const empty = clusterCat!.checks.find(c => c.name === 'empty_clusters')
  expect(empty!.count).toBe(1)
  expect(empty!.severity).toBe('warning')
})

test('detects singleton clusters', () => {
  const cluster = seedThought({ content: 'singleton cluster', is_cluster: 1 })
  const member = seedThought({ content: 'member' })
  seedEdge(cluster, member, 'cluster')

  const report = runHealthCheck()
  const clusterCat = report.categories.find(c => c.name === 'cluster_health')
  const singleton = clusterCat!.checks.find(c => c.name === 'singleton_clusters')
  expect(singleton!.count).toBe(1)
})

test('detects island thoughts', () => {
  seedThought({ content: 'island thought' })

  const report = runHealthCheck()
  const conn = report.categories.find(c => c.name === 'connectivity')
  const islands = conn!.checks.find(c => c.name === 'island_thoughts')
  expect(islands!.count).toBe(1)
  expect(islands!.severity).toBe('warning')
})

test('does not flag cluster thoughts as islands', () => {
  seedThought({ content: 'cluster', is_cluster: 1 })

  const report = runHealthCheck()
  const conn = report.categories.find(c => c.name === 'connectivity')
  const islands = conn!.checks.find(c => c.name === 'island_thoughts')
  expect(islands!.count).toBe(0)
})

test('detects duplicate content', () => {
  seedThought({ content: 'exact duplicate content here' })
  seedThought({ content: 'exact duplicate content here' })

  const report = runHealthCheck()
  const contentCat = report.categories.find(c => c.name === 'content_quality')
  const dupes = contentCat!.checks.find(c => c.name === 'duplicate_content')
  expect(dupes!.count).toBe(1)
})

test('detects too short content', () => {
  seedThought({ content: 'hi' })

  const report = runHealthCheck()
  const contentCat = report.categories.find(c => c.name === 'content_quality')
  const short = contentCat!.checks.find(c => c.name === 'too_short_content')
  expect(short!.count).toBe(1)
})

test('detects test remnants', () => {
  seedThought({ content: 'Test thought A' })
  seedThought({ content: 'Test thought B' })

  const report = runHealthCheck()
  const contentCat = report.categories.find(c => c.name === 'content_quality')
  const testR = contentCat!.checks.find(c => c.name === 'test_remnants')
  expect(testR!.count).toBe(2)
})

test('detects stale drafts', () => {
  const db = getDb()
  const id = crypto.randomUUID()
  const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
  db.prepare('INSERT INTO thoughts (id, content, status, project_id, is_cluster, is_profile, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'old draft', 'draft', 'default', 0, 0, oldDate, oldDate)

  const report = runHealthCheck()
  const contentCat = report.categories.find(c => c.name === 'content_quality')
  const stale = contentCat!.checks.find(c => c.name === 'stale_drafts')
  expect(stale!.count).toBe(1)
})

test('detects circular parent chains', () => {
  const a = seedThought({ content: 'A' })
  const b = seedThought({ content: 'B' })
  const c = seedThought({ content: 'C' })
  seedEdge(a, b, 'parent')
  seedEdge(b, c, 'parent')
  seedEdge(c, a, 'parent')

  const report = runHealthCheck()
  const semantic = report.categories.find(c => c.name === 'semantic_consistency')
  const circular = semantic!.checks.find(c => c.name === 'circular_chains')
  expect(circular!.count).toBeGreaterThan(0)
  expect(circular!.severity).toBe('warning')
})

test('detects broken parent chains', () => {
  const a = seedThought({ content: 'active parent' })
  const b = seedThought({ content: 'archived child', status: 'archived' })
  seedEdge(a, b, 'parent')

  const report = runHealthCheck()
  const semantic = report.categories.find(c => c.name === 'semantic_consistency')
  const broken = semantic!.checks.find(c => c.name === 'broken_parent_chains')
  expect(broken!.count).toBe(1)
})

test('filters by severity', () => {
  seedThought({ content: 'hi' }) // triggers info (too_short)
  seedThought({ content: 'island' }) // triggers warning (island)

  const reportCritical = runHealthCheck({ severity: 'critical' })
  // Only structural checks with count > 0 should appear
  const critChecks = reportCritical.categories.flatMap(c => c.checks)
  expect(critChecks.every(c => c.count === 0 || c.severity === 'critical')).toBe(true)

  const reportWarning = runHealthCheck({ severity: 'warning' })
  const warningChecks = reportWarning.categories.flatMap(c => c.checks)
  expect(warningChecks.some(c => c.name === 'island_thoughts')).toBe(true)
  expect(warningChecks.some(c => c.name === 'too_short_content')).toBe(false)
})

test('health score decreases with issues', () => {
  const clean = runHealthCheck()
  expect(clean.summary.health_score).toBe(100)

  // Add orphan edge (insert directly, then orphan it)
  const a = seedThought({ content: 'A' })
  const b = seedThought({ content: 'B' })
  const db = getDb()
  const edgeId = crypto.randomUUID()
  db.prepare('INSERT INTO edges (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, ?, ?)').run(edgeId, a, b, 'related', new Date().toISOString())
  db.run('PRAGMA foreign_keys = OFF')
  db.prepare('DELETE FROM thoughts WHERE id = ?').run(a)
  db.run('PRAGMA foreign_keys = ON')

  const dirty = runHealthCheck()
  expect(dirty.summary.health_score).toBeLessThan(100)
  expect(dirty.summary.issues.critical).toBeGreaterThan(0)
})

test('fix mode removes orphan edges', () => {
  const a = seedThought({ content: 'A' })
  const b = seedThought({ content: 'B' })
  const db = getDb()
  const edgeId = crypto.randomUUID()
  db.prepare('INSERT INTO edges (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, ?, ?)').run(edgeId, a, b, 'related', new Date().toISOString())
  db.run('PRAGMA foreign_keys = OFF')
  db.prepare('DELETE FROM thoughts WHERE id = ?').run(a)
  db.run('PRAGMA foreign_keys = ON')

  const before = runHealthCheck()
  expect(before.summary.issues.critical).toBeGreaterThan(0)

  runHealthCheck({ fix: true })
  const after = runHealthCheck()
  expect(after.summary.issues.critical).toBe(0)
})

test('fix mode removes empty clusters', () => {
  seedThought({ content: 'empty cluster', is_cluster: 1 })

  const before = runHealthCheck()
  const emptyBefore = before.categories.find(c => c.name === 'cluster_health')!.checks.find(c => c.name === 'empty_clusters')!
  expect(emptyBefore.count).toBe(1)

  runHealthCheck({ fix: true })
  const after = runHealthCheck()
  const emptyAfter = after.categories.find(c => c.name === 'cluster_health')!.checks.find(c => c.name === 'empty_clusters')!
  expect(emptyAfter.count).toBe(0)
})
