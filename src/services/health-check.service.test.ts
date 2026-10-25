import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../db'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { runHealthCheckService } from './health-check.service'
import { runHealthRepairService } from './health-check-repair.service'
import { ValidationError } from '../errors'

beforeEach(createTestDb)
afterEach(() => {
  const { closeDb } = require('../db/init')
  closeDb()
})

test('runHealthCheckService returns valid structure on empty DB', () => {
  const report = runHealthCheckService()
  expect(Object.keys(report).sort()).toEqual(['categories', 'summary'])
  expect(Object.keys(report.summary).sort()).toEqual([
    'active', 'archived', 'critical', 'critical_count', 'critical_issues', 'draft', 'formula',
    'health_score', 'info', 'info_count', 'info_issues', 'issues', 'score_breakdown',
    'score_components', 'score_details', 'score_explanation', 'score_formula', 'score_composition',
    'total_clusters', 'total_edges', 'total_thoughts', 'warning', 'warning_count', 'warning_issues'
  ].sort())
  expect(report.summary.total_thoughts).toBe(0)
  expect(report.summary.total_edges).toBe(0)
  expect(report.summary.health_score).toBe(100)
  expect(report.summary.issues).toEqual({ critical: 0, warning: 0, info: 0 })
  expect(report.summary.critical).toBe(report.summary.critical_count)
  expect(report.summary.critical).toBe(report.summary.critical_issues)
  expect(report.summary.warning).toBe(report.summary.warning_count)
  expect(report.summary.warning).toBe(report.summary.warning_issues)
  expect(report.summary.info).toBe(report.summary.info_count)
  expect(report.summary.info).toBe(report.summary.info_issues)
  expect(report.summary.score_composition).toBe(report.summary.score_breakdown)
  expect(report.summary.score_explanation).toBe(report.summary.score_breakdown)
  expect(report.summary.score_components).toBe(report.summary.score_breakdown)
  expect(report.summary.score_details).toBe(report.summary.score_breakdown)
  expect(report.summary.formula).toBe(report.summary.score_formula)
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

  const report = runHealthCheckService()
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

  const report = runHealthCheckService()
  const structural = report.categories.find(c => c.name === 'structural_integrity')
  const selfLoop = structural!.checks.find(c => c.name === 'self_loop_edges')
  expect(selfLoop!.count).toBe(1)
  expect(selfLoop!.severity).toBe('critical')
})

function clusterViolationCount(): number {
  const report = runHealthCheckService()
  const structural = report.categories.find(c => c.name === 'structural_integrity')
  return structural!.checks.find(c => c.name === 'cluster_constraint_violations')!.count
}

test('allows cluster membership edges from a cluster to a regular thought', () => {
  const cluster = seedThought({ content: 'valid cluster', is_cluster: 1 })
  const member = seedThought({ content: 'valid member' })
  seedEdge(cluster, member, 'cluster')

  expect(clusterViolationCount()).toBe(0)
})

test('allows references between thoughts of the same cluster kind', () => {
  const regularA = seedThought({ content: 'regular A' })
  const regularB = seedThought({ content: 'regular B' })
  const clusterA = seedThought({ content: 'cluster A', is_cluster: 1 })
  const clusterB = seedThought({ content: 'cluster B', is_cluster: 1 })
  seedEdge(regularA, regularB, 'references')
  seedEdge(clusterA, clusterB, 'references')

  expect(clusterViolationCount()).toBe(0)
})

test('reports each invalid regular edge involving a cluster once', () => {
  const cluster = seedThought({ content: 'cluster', is_cluster: 1 })
  const regular = seedThought({ content: 'regular' })
  seedEdge(cluster, regular, 'related')

  expect(clusterViolationCount()).toBe(1)
})

test('reports an invalid cluster edge between regular thoughts once', () => {
  const regularA = seedThought({ content: 'regular A' })
  const regularB = seedThought({ content: 'regular B' })
  seedEdge(regularA, regularB, 'cluster')

  expect(clusterViolationCount()).toBe(1)
})

test('detects mixed references and cluster edges targeting clusters', () => {
  const clusterA = seedThought({ content: 'cluster A', is_cluster: 1 })
  const clusterB = seedThought({ content: 'cluster B', is_cluster: 1 })
  const regular = seedThought({ content: 'regular' })
  seedEdge(clusterA, regular, 'references')
  seedEdge(clusterA, clusterB, 'cluster')

  expect(clusterViolationCount()).toBe(2)
})

test('detects empty clusters', () => {
  seedThought({ content: 'empty cluster', is_cluster: 1 })

  const report = runHealthCheckService()
  const clusterCat = report.categories.find(c => c.name === 'cluster_health')
  const empty = clusterCat!.checks.find(c => c.name === 'empty_clusters')
  expect(empty!.count).toBe(1)
  expect(empty!.severity).toBe('warning')
})

test('detects singleton clusters', () => {
  const cluster = seedThought({ content: 'singleton cluster', is_cluster: 1 })
  const member = seedThought({ content: 'member' })
  seedEdge(cluster, member, 'cluster')

  const report = runHealthCheckService()
  const clusterCat = report.categories.find(c => c.name === 'cluster_health')
  const singleton = clusterCat!.checks.find(c => c.name === 'singleton_clusters')
  expect(singleton!.count).toBe(1)
})

test('detects island thoughts', () => {
  seedThought({ content: 'island thought' })

  const report = runHealthCheckService()
  const conn = report.categories.find(c => c.name === 'connectivity')
  const islands = conn!.checks.find(c => c.name === 'island_thoughts')
  expect(islands!.count).toBe(1)
  expect(islands!.severity).toBe('info')
})

test('does not flag cluster thoughts as islands', () => {
  seedThought({ content: 'cluster', is_cluster: 1 })

  const report = runHealthCheckService()
  const conn = report.categories.find(c => c.name === 'connectivity')
  const islands = conn!.checks.find(c => c.name === 'island_thoughts')
  expect(islands!.count).toBe(0)
})

test('detects duplicate content', () => {
  seedThought({ content: 'exact duplicate content here' })
  seedThought({ content: 'exact duplicate content here' })

  const report = runHealthCheckService()
  const contentCat = report.categories.find(c => c.name === 'content_quality')
  const dupes = contentCat!.checks.find(c => c.name === 'duplicate_content')
  expect(dupes!.count).toBe(1)
})

test('detects too short content', () => {
  seedThought({ content: 'hi' })

  const report = runHealthCheckService()
  const contentCat = report.categories.find(c => c.name === 'content_quality')
  const short = contentCat!.checks.find(c => c.name === 'too_short_content')
  expect(short!.count).toBe(1)
})

test('detects test remnants', () => {
  seedThought({ content: 'Test thought A' })
  seedThought({ content: 'Test thought B' })

  const report = runHealthCheckService()
  const contentCat = report.categories.find(c => c.name === 'content_quality')
  const testR = contentCat!.checks.find(c => c.name === 'test_remnants')
  expect(testR!.count).toBe(2)
})

test('detects stale drafts', () => {
  const db = getDb()
  const id = crypto.randomUUID()
  const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
  db.prepare('INSERT INTO thoughts (id, content, status, project_id, is_cluster, is_profile, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'old draft', 'draft', 'default', 0, 0, oldDate, oldDate)

  const report = runHealthCheckService()
  const contentCat = report.categories.find(c => c.name === 'content_quality')
  const stale = contentCat!.checks.find(c => c.name === 'stale_drafts')
  expect(stale!.count).toBe(1)
})

/** The registered `duplicate_drafts` check from a health report. */
function duplicateDraftCheck(report: ReturnType<typeof runHealthCheckService>) {
  const contentCat = report.categories.find(c => c.name === 'content_quality')!
  return contentCat.checks.find(c => c.name === 'duplicate_drafts')!
}

test('registers duplicate_drafts as a warning finding with the draft pair in details', () => {
  const active = seedThought({ content: 'alpha beta gamma delta', status: 'active' })
  const draft = seedThought({ content: 'alpha beta gamma delta epsilon', status: 'draft' })

  const check = duplicateDraftCheck(runHealthCheckService())

  expect(check.severity).toBe('warning')
  expect(check.count).toBe(1)
  expect(check.details).toEqual([
    expect.objectContaining({ draft_id: draft, duplicate_of: active })
  ])
  // Read-only by design: the finding declares no repair hook.
  expect(check.auto_fixable).toBeUndefined()
})

test('reports no duplicate_drafts on an empty DB', () => {
  expect(duplicateDraftCheck(runHealthCheckService()).count).toBe(0)
})

test('fix mode does not repair duplicate_drafts', () => {
  const db = getDb()
  // Unprotected on purpose: a repair hook would really delete them, so the
  // count assertion below pins the absence of a repair rather than a guard.
  const active = seedThought({ content: 'alpha beta gamma delta', status: 'active', is_protected: 0 })
  const draft = seedThought({ content: 'alpha beta gamma delta epsilon', status: 'draft', is_protected: 0 })

  expect(duplicateDraftCheck(runHealthCheckService()).count).toBe(1)

  const _repairPreview = runHealthRepairService()
  runHealthRepairService({ confirm: true, preview_token: _repairPreview.preview_token })

  // The count is unchanged and neither side was merged, archived or deleted:
  // a duplicate draft needs a human decision.
  expect(duplicateDraftCheck(runHealthCheckService()).count).toBe(1)
  const rows = db.prepare('SELECT id, status FROM thoughts ORDER BY id').all() as Array<{ id: string; status: string }>
  expect(rows).toEqual(
    [
      { id: active, status: 'active' },
      { id: draft, status: 'draft' }
    ].sort((a, b) => a.id.localeCompare(b.id))
  )
})

test('detects circular parent chains', () => {
  const a = seedThought({ content: 'A' })
  const b = seedThought({ content: 'B' })
  const c = seedThought({ content: 'C' })
  seedEdge(a, b, 'parent')
  seedEdge(b, c, 'parent')
  seedEdge(c, a, 'parent')

  const report = runHealthCheckService()
  const semantic = report.categories.find(c => c.name === 'semantic_consistency')
  const circular = semantic!.checks.find(c => c.name === 'circular_chains')
  expect(circular!.count).toBeGreaterThan(0)
  expect(circular!.severity).toBe('warning')
})

test('detects broken parent chains', () => {
  const a = seedThought({ content: 'active parent' })
  const b = seedThought({ content: 'archived child', status: 'archived' })
  seedEdge(a, b, 'parent')

  const report = runHealthCheckService()
  const semantic = report.categories.find(c => c.name === 'semantic_consistency')
  const broken = semantic!.checks.find(c => c.name === 'broken_parent_chains')
  expect(broken!.count).toBe(1)
})

test('filters by severity', () => {
  seedThought({ content: 'hi' }) // triggers info (too_short)
  seedThought({ content: 'island' }) // triggers info (island — downgraded from warning)

  const reportCritical = runHealthCheckService({ severity: 'critical' })
  // Only structural checks with count > 0 should appear
  const critChecks = reportCritical.categories.flatMap(c => c.checks)
  expect(critChecks.every(c => c.count === 0 || c.severity === 'critical')).toBe(true)

  const reportWarning = runHealthCheckService({ severity: 'warning' })
  const warningChecks = reportWarning.categories.flatMap(c => c.checks)
  // island_thoughts is now info, so it should NOT appear in warning filter
  expect(warningChecks.some(c => c.name === 'island_thoughts')).toBe(false)
  expect(warningChecks.some(c => c.name === 'too_short_content')).toBe(false)
})

test('health score decreases with issues', () => {
  const clean = runHealthCheckService()
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

  const dirty = runHealthCheckService()
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

  const before = runHealthCheckService()
  expect(before.summary.issues.critical).toBeGreaterThan(0)

  const _repairPreview = runHealthRepairService()
  runHealthRepairService({ confirm: true, preview_token: _repairPreview.preview_token })
  const after = runHealthCheckService()
  expect(after.summary.issues.critical).toBe(0)
})

test('fix mode removes empty clusters', () => {
  seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })

  const before = runHealthCheckService()
  const emptyBefore = before.categories.find(c => c.name === 'cluster_health')!.checks.find(c => c.name === 'empty_clusters')!
  expect(emptyBefore.count).toBe(1)

  const _repairPreview = runHealthRepairService()
  runHealthRepairService({ confirm: true, preview_token: _repairPreview.preview_token })
  const after = runHealthCheckService()
  const emptyAfter = after.categories.find(c => c.name === 'cluster_health')!.checks.find(c => c.name === 'empty_clusters')!
  expect(emptyAfter.count).toBe(0)
})

test('fix mode deletes archived-target parent edges but keeps draft-target ones', () => {
  const parent = seedThought({ content: 'active parent' })
  const archivedChild = seedThought({ content: 'archived child', status: 'archived' })
  const draftChild = seedThought({ content: 'draft child', status: 'draft' })
  seedEdge(parent, archivedChild, 'parent')
  seedEdge(parent, draftChild, 'parent')

  const _repairPreview = runHealthRepairService()
  runHealthRepairService({ confirm: true, preview_token: _repairPreview.preview_token })

  const remaining = getDb()
    .prepare("SELECT target_id FROM edges WHERE type = 'parent'")
    .all() as Array<{ target_id: string }>
  expect(remaining.map(r => r.target_id)).toEqual([draftChild])
})

test('empty-cluster repair clears both empty and singleton counts', () => {
  seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })

  const before = runHealthCheckService()
  const clusterCatBefore = before.categories.find(c => c.name === 'cluster_health')!
  const emptyBefore = clusterCatBefore.checks.find(c => c.name === 'empty_clusters')!
  const singletonBefore = clusterCatBefore.checks.find(c => c.name === 'singleton_clusters')!
  expect(emptyBefore.count).toBe(1)
  // An empty cluster (0 members) also qualifies as a singleton (<=1 member).
  expect(singletonBefore.count).toBeGreaterThanOrEqual(1)

  const preview = runHealthRepairService()
  runHealthRepairService({ confirm: true, preview_token: preview.preview_token })

  const after = runHealthCheckService()
  const clusterCatAfter = after.categories.find(c => c.name === 'cluster_health')!
  const emptyAfter = clusterCatAfter.checks.find(c => c.name === 'empty_clusters')!
  const singletonAfter = clusterCatAfter.checks.find(c => c.name === 'singleton_clusters')!
  expect(emptyAfter.count).toBe(0)
  expect(singletonAfter.count).toBe(0)
})

test('repair throws ValidationError on missing preview token', () => {
  seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })
  runHealthRepairService() // create a preview (unused)
  expect(() => runHealthRepairService({ confirm: true })).toThrow(ValidationError)
})

test('repair throws ValidationError on bogus preview token', () => {
  seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })
  expect(() => runHealthRepairService({ confirm: true, preview_token: 'bogus-token' })).toThrow(ValidationError)
})

test('repair throws ValidationError on stale preview token', () => {
  seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })
  const preview = runHealthRepairService()

  // Change state so the fingerprint no longer matches.
  seedThought({ content: 'another empty cluster', is_cluster: 1, is_protected: 0 })

  expect(() => runHealthRepairService({ confirm: true, preview_token: preview.preview_token })).toThrow(ValidationError)
})

test('repair throws ValidationError on replayed preview token', () => {
  seedThought({ content: 'empty cluster', is_cluster: 1, is_protected: 0 })
  const preview = runHealthRepairService()
  runHealthRepairService({ confirm: true, preview_token: preview.preview_token })

  // Re-seed so a second repair attempt has something to fix, but token is consumed.
  seedThought({ content: 'empty cluster 2', is_cluster: 1, is_protected: 0 })
  const preview2 = runHealthRepairService()
  // Use the already-consumed first token against the new fingerprint context: still invalid.
  expect(() => runHealthRepairService({ confirm: true, preview_token: preview.preview_token })).toThrow(ValidationError)
  // sanity: a fresh token works
  runHealthRepairService({ confirm: true, preview_token: preview2.preview_token })
})

test('repaired count reflects actually repaired targets (protected skipped)', () => {
  const protectedId = seedThought({ content: 'protected empty cluster', is_cluster: 1, is_protected: 1 })
  const unprotectedId = seedThought({ content: 'unprotected empty cluster', is_cluster: 1, is_protected: 0 })

  const before = runHealthCheckService()
  const emptyBefore = before.categories.find(c => c.name === 'cluster_health')!.checks.find(c => c.name === 'empty_clusters')!
  // Both are counted as repairable before (including protected).
  expect(emptyBefore.count).toBe(2)

  const preview = runHealthRepairService()
  const result = runHealthRepairService({ confirm: true, preview_token: preview.preview_token })

  expect(result.status).toBe('executed')
  const emptyRepaired = result.repaired?.find(r => r.name === 'empty_clusters')
  // Only the unprotected one was actually archived.
  expect(emptyRepaired?.count).toBe(1)

  const db = getDb()
  const protectedRow = db.prepare('SELECT status FROM thoughts WHERE id = ?').get(protectedId) as { status: string }
  const unprotectedRow = db.prepare('SELECT status FROM thoughts WHERE id = ?').get(unprotectedId) as { status: string }
  expect(protectedRow.status).toBe('active')
  expect(unprotectedRow.status).toBe('archived')
})
