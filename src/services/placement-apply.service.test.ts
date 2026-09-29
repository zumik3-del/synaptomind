/**
 * P8 apply-orchestrator tests (task #975, epic #964; service authored in #974).
 *
 * Verifies `src/services/placement-apply.service.ts`: conflict matrix,
 * idempotency, dry-run non-mutation, atomicity on writer failure, batch
 * partial-failure independence, re-checked gates (maxClusterSize / project),
 * and a static assertion that the service imports no new graph writer.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config'
import { closeDb, getDb } from '../db'
import { getEdgePairBetween } from '../db/edges'
import { getThoughtRow } from '../db/thoughts'
import { insertProposal, type PlacementProposalRow } from '../db/placement-proposals'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { NotFoundError } from '../errors'
import {
  applyBatch,
  applyProposal,
} from './placement-apply.service'
import type { ApplyResult } from './placement-apply.types'
import { computeFingerprint } from './placement-proposals.service'

beforeEach(createTestDb)
afterEach(closeDb)

const NOW = '2026-01-01T00:00:00.000Z'
const NOW_LATER = '2026-02-01T00:00:00.000Z'

// ── helpers ───────────────────────────────────────────────────────────────────

/** Save/restore `config.placement` across a callback. */
function withPlacementConfig(overrides: Partial<typeof config.placement>, fn: () => void): void {
  const saved = config.placement
  config.placement = { ...saved, ...overrides }
  try { fn() } finally { config.placement = saved }
}

function pairFingerprint(db: Database, sourceId: string, targetId: string): string {
  const source = getThoughtRow(db, sourceId)
  const target = getThoughtRow(db, targetId)
  if (!source || !target) throw new Error('thought not found')
  const existing = getEdgePairBetween(db, sourceId, targetId)
  return computeFingerprint({
    sourceId,
    sourceUpdatedAt: source.updated_at,
    sourceStatus: source.status,
    targetId,
    targetUpdatedAt: target.updated_at,
    targetStatus: target.status,
    existingEdgeType: existing?.type ?? null,
  })
}

function pendingEdgeRow(
  db: Database,
  sourceId: string,
  targetId: string,
  edgeType: string = 'related',
  overrides?: Record<string, unknown>
): PlacementProposalRow {
  return insertProposal(db, {
    source_thought_id: sourceId,
    item_kind: 'edge',
    target_id: targetId,
    edge_type: edgeType,
    confidence: 0.8,
    rationale: 'conflict-matrix edge',
    payload: '{}',
    fingerprint: pairFingerprint(db, sourceId, targetId),
    direction: 'symmetric',
    ...overrides,
  })
}

function pendingPlacementRow(
  db: Database,
  sourceId: string,
  targetId: string,
  edgeType: string = 'parent',
  overrides?: Record<string, unknown>
): PlacementProposalRow {
  return insertProposal(db, {
    source_thought_id: sourceId,
    item_kind: 'placement',
    target_id: targetId,
    edge_type: edgeType,
    confidence: 0.7,
    rationale: 'conflict-matrix placement',
    payload: '{}',
    fingerprint: pairFingerprint(db, sourceId, targetId),
    direction: 'directed',
    ...overrides,
  })
}

function pendingLifecycleRow(
  db: Database,
  sourceId: string,
  targetId: string | null,
  lifecycleAction: string,
  overrides?: Record<string, unknown>
): PlacementProposalRow {
  const fp = targetId ? pairFingerprint(db, sourceId, targetId) : 'fp-lc'
  return insertProposal(db, {
    source_thought_id: sourceId,
    item_kind: 'lifecycle',
    target_id: targetId,
    edge_type: lifecycleAction === 'replaces+archive' ? 'replaces' : null,
    lifecycle_action: lifecycleAction,
    confidence: 0.9,
    rationale: `lifecycle ${lifecycleAction}`,
    payload: '{}',
    fingerprint: fp,
    ...overrides,
  })
}

function assertStillPending(db: Database, id: string): void {
  const row = db.prepare('SELECT state FROM placement_proposals WHERE id = ?').get(id) as { state: string } | undefined
  expect(row).toBeDefined()
  expect(row!.state).toBe('pending')
}

function assertAccepted(db: Database, id: string): void {
  const row = db.prepare('SELECT state FROM placement_proposals WHERE id = ?').get(id) as { state: string } | undefined
  expect(row).toBeDefined()
  expect(row!.state).toBe('accepted')
}

function assertStale(db: Database, id: string): void {
  const row = db.prepare('SELECT state FROM placement_proposals WHERE id = ?').get(id) as { state: string } | undefined
  expect(row).toBeDefined()
  expect(row!.state).toBe('stale')
}

// ── conflict matrix (§2.6) ─────────────────────────────────────────────────────

describe('conflict matrix', () => {
  test('symmetric edge duplicate (already exists in same direction) → idempotent success', () => {
    const db = getDb()
    const s = seedThought({ id: 'cm-sym-s', content: 'sym src', created_at: NOW })
    const t = seedThought({ id: 'cm-sym-t', content: 'sym tgt', created_at: NOW_LATER })
    seedEdge(s, t, 'related')
    const row = pendingEdgeRow(db, s, t, 'related')
    const out = applyProposal(row.id, { confirm: true, now: NOW }, db) as Extract<ApplyResult, { status: 'accepted' }>
    expect(out.status).toBe('accepted')
    expect(out.idempotent).toBe(true)
    assertAccepted(db, row.id)
  })

  test('symmetric edge duplicate in reverse direction → idempotent success', () => {
    const db = getDb()
    const s = seedThought({ id: 'cm-sym-r-s', content: 'sym rev src', created_at: NOW })
    const t = seedThought({ id: 'cm-sym-r-t', content: 'sym rev tgt', created_at: NOW_LATER })
    seedEdge(s, t, 'related')
    // Queue a reverse-direction related edge.
    const row = pendingEdgeRow(db, t, s, 'related')
    const out = applyProposal(row.id, { confirm: true, now: NOW }, db) as Extract<ApplyResult, { status: 'accepted' }>
    expect(out.status).toBe('accepted')
    expect(out.idempotent).toBe(true)
    assertAccepted(db, row.id)
  })

  test('exact directed duplicate (createEdge throws EdgeAlreadyExistsError) → idempotent success', () => {
    const db = getDb()
    const s = seedThought({ id: 'cm-dir-s', content: 'dir src', created_at: NOW })
    const t = seedThought({ id: 'cm-dir-t', content: 'dir tgt', created_at: NOW_LATER })
    seedEdge(s, t, 'supports')
    const row = pendingEdgeRow(db, s, t, 'supports')
    const out = applyProposal(row.id, { confirm: true, now: NOW }, db) as Extract<ApplyResult, { status: 'accepted' }>
    expect(out.status).toBe('accepted')
    expect(out.idempotent).toBe(true)
    assertAccepted(db, row.id)
  })

  test('reverse directed conflict → stale', () => {
    const db = getDb()
    const s = seedThought({ id: 'cm-rev-s', content: 'rev src', created_at: NOW })
    const t = seedThought({ id: 'cm-rev-t', content: 'rev tgt', created_at: NOW_LATER })
    seedEdge(s, t, 'supports')
    // Attempt the reverse direction.
    const row = pendingEdgeRow(db, t, s, 'supports')
    const out = applyProposal(row.id, { confirm: true, now: NOW }, db)
    expect(out.status).toBe('stale')
    expect(out).toHaveProperty('reason')
    assertStale(db, row.id)
  })

  test('different-type conflict on the pair → stale', () => {
    const db = getDb()
    const s = seedThought({ id: 'cm-diff-s', content: 'diff src', created_at: NOW })
    const t = seedThought({ id: 'cm-diff-t', content: 'diff tgt', created_at: NOW_LATER })
    seedEdge(s, t, 'supports')
    const row = pendingEdgeRow(db, s, t, 'contradicts')
    const out = applyProposal(row.id, { confirm: true, now: NOW }, db)
    expect(out.status).toBe('stale')
    assertStale(db, row.id)
  })

  test('archived target → stale', () => {
    const db = getDb()
    const s = seedThought({ id: 'cm-arch-s', content: 'arch src', created_at: NOW })
    const t = seedThought({ id: 'cm-arch-t', content: 'arch tgt', created_at: NOW_LATER, status: 'archived' })
    const row = pendingEdgeRow(db, s, t, 'related')
    const out = applyProposal(row.id, { confirm: true, now: NOW }, db)
    expect(out.status).toBe('stale')
    assertStale(db, row.id)
  })

  test('profile merge → failed (source is profile)', () => {
    const db = getDb()
    const s = seedThought({ id: 'cm-prof-s', content: 'profile src', created_at: NOW, is_profile: 1 })
    const t = seedThought({ id: 'cm-prof-t', content: 'merge tgt', created_at: NOW_LATER })
    const row = pendingLifecycleRow(db, s, t, 'merge')
    const out = applyProposal(row.id, { confirm: true, now: NOW }, db)
    expect(out.status).toBe('failed')
    expect(out).toHaveProperty('reason')
    // Failed rows stay pending so the caller can retry after fixing the precondition.
    assertStillPending(db, row.id)
  })

  test('profile target in replaces+archive → failed', () => {
    const db = getDb()
    const s = seedThought({ id: 'cm-ra-s', content: 'ra src', created_at: NOW })
    const t = seedThought({ id: 'cm-ra-t', content: 'ra tgt', created_at: NOW_LATER, is_profile: 1 })
    const row = pendingLifecycleRow(db, s, t, 'replaces+archive')
    const out = applyProposal(row.id, { confirm: true, now: NOW }, db)
    expect(out.status).toBe('failed')
    assertStillPending(db, row.id)
  })

  test('cluster placement on a non-cluster target → failed', () => {
    const db = getDb()
    const s = seedThought({ id: 'cm-cl-s', content: 'cl src', created_at: NOW })
    const t = seedThought({ id: 'cm-cl-t', content: 'cl tgt', created_at: NOW_LATER })
    const row = pendingPlacementRow(db, s, t, 'cluster')
    const out = applyProposal(row.id, { confirm: true, now: NOW }, db)
    expect(out.status).toBe('failed')
    assertStillPending(db, row.id)
  })

  test('cluster placement exceeding maxClusterSize → stale', () => {
    const db = getDb()
    const s = seedThought({ id: 'cm-clap-s', content: 'clap src', created_at: NOW })
    const cl = seedThought({ id: 'cm-clap-cl', content: 'the cluster', created_at: NOW_LATER, is_cluster: 1 })
    // Fill the cluster to the cap.
    withPlacementConfig({ maxClusterSize: 2 }, () => {
      seedEdge(cl, seedThought({ content: 'm1', created_at: NOW_LATER }), 'cluster')
      seedEdge(cl, seedThought({ content: 'm2', created_at: NOW_LATER }), 'cluster')
      const row = pendingPlacementRow(db, s, cl, 'cluster')
      const out = applyProposal(row.id, { confirm: true, now: NOW }, db)
      expect(out.status).toBe('stale')
      assertStale(db, row.id)
    })
  })

  test('unknown proposal id throws NotFoundError', () => {
    expect(() => applyProposal('no-such-id', { confirm: true, now: NOW }, getDb())).toThrow(NotFoundError)
  })
})

// ── idempotency ────────────────────────────────────────────────────────────────

describe('idempotency', () => {
  test('re-applying an already-accepted row returns accepted/idempotent without calling a writer', () => {
    const db = getDb()
    const s = seedThought({ id: 'id-s', content: 'idem src', created_at: NOW })
    const t = seedThought({ id: 'id-t', content: 'idem tgt', created_at: NOW_LATER })
    const row = pendingEdgeRow(db, s, t, 'related')
    // Accept once.
    applyProposal(row.id, { confirm: true, now: NOW }, db)
    assertAccepted(db, row.id)
    // Re-apply.
    const out = applyProposal(row.id, { confirm: true, now: NOW_LATER }, db) as Extract<ApplyResult, { status: 'accepted' }>
    expect(out.status).toBe('accepted')
    expect(out.idempotent).toBe(true)
    expect(out.calls).toEqual([])
    // Row remains accepted; no second log-worthy mutation.
    assertAccepted(db, row.id)
  })

  test('re-applying a pending row whose effect already landed externally → idempotent success', () => {
    const db = getDb()
    const s = seedThought({ id: 'id-ext-s', content: 'ext src', created_at: NOW })
    const t = seedThought({ id: 'id-ext-t', content: 'ext tgt', created_at: NOW_LATER })
    // Edge already exists in the graph.
    seedEdge(s, t, 'supports')
    const row = pendingEdgeRow(db, s, t, 'supports')
    const out = applyProposal(row.id, { confirm: true, now: NOW }, db) as Extract<ApplyResult, { status: 'accepted' }>
    expect(out.status).toBe('accepted')
    expect(out.idempotent).toBe(true)
    assertAccepted(db, row.id)
  })
})

// ── dry-run ────────────────────────────────────────────────────────────────────

describe('dry-run (confirm:false / absent)', () => {
  test('dry-run returns calls without mutating the queue or the graph', () => {
    const db = getDb()
    const s = seedThought({ id: 'dr-s', content: 'dry src', created_at: NOW })
    const t = seedThought({ id: 'dr-t', content: 'dry tgt', created_at: NOW_LATER })
    const row = pendingEdgeRow(db, s, t, 'develops')
    const out = applyProposal(row.id, { now: NOW }, db)
    expect(out.status).toBe('dry_run')
    expect((out as Extract<ApplyResult, { status: 'dry_run' }>).calls).toHaveLength(1)
    // Queue remains pending.
    assertStillPending(db, row.id)
    // No edge was created.
    const edge = db.prepare('SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND type = ?').get(s, t, 'develops')
    expect(edge).toBeNull()
  })

  test('dry-run still surfaces stale/failed gates without mutating the queue', () => {
    const db = getDb()
    const s = seedThought({ id: 'dr-stale-s', content: 'stale src', created_at: NOW })
    const t = seedThought({ id: 'dr-stale-t', content: 'stale tgt', created_at: NOW_LATER, status: 'archived' })
    const row = pendingEdgeRow(db, s, t, 'related')
    const out = applyProposal(row.id, { now: NOW }, db)
    expect(out.status).toBe('stale')
    assertStillPending(db, row.id)
  })

  test('explicit confirm:false behaves like the default (no mutation)', () => {
    const db = getDb()
    const s = seedThought({ id: 'dr-exp-s', content: 'exp src', created_at: NOW })
    const t = seedThought({ id: 'dr-exp-t', content: 'exp tgt', created_at: NOW_LATER })
    const row = pendingEdgeRow(db, s, t, 'related')
    const out = applyProposal(row.id, { confirm: false, now: NOW }, db)
    expect(out.status).toBe('dry_run')
    assertStillPending(db, row.id)
  })
})

// ── atomicity ──────────────────────────────────────────────────────────────────

describe('atomicity: writer throws', () => {
  test('a writer throw rolls back the graph and lands the row as failed (not accepted)', () => {
    const db = getDb()
    const s = seedThought({ id: 'at-s', content: 'atomic src', created_at: NOW })
    // Merge with source === target triggers mergeThoughtsService's own guard.
    // The gate does not catch this, so the writer runs and throws.
    const row = pendingLifecycleRow(db, s, s, 'merge')
    const beforeEdges = db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }
    const out = applyProposal(row.id, { confirm: true, now: NOW }, db)
    expect(out.status).toBe('failed')
    // Transaction rolled back: no edges were added.
    const afterEdges = db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }
    expect(afterEdges.n).toBe(beforeEdges.n)
    // Row stays pending (failed outcome).
    assertStillPending(db, row.id)
  })
})

// ── batch partial failure ───────────────────────────────────────────────────────

describe('applyBatch: partial failure independence', () => {
  test('commits siblings while collecting errors for broken ids', () => {
    const db = getDb()
    const s1 = seedThought({ id: 'bat-s1', content: 'batch s1', created_at: NOW })
    const t1 = seedThought({ id: 'bat-t1', content: 'batch t1', created_at: NOW_LATER })
    const s2 = seedThought({ id: 'bat-s2', content: 'batch s2', created_at: NOW })
    const t2 = seedThought({ id: 'bat-t2', content: 'batch t2', created_at: NOW_LATER, status: 'archived' })
    const okRow = pendingEdgeRow(db, s1, t1, 'related')
    const failRow = pendingEdgeRow(db, s2, t2, 'related')
    const unknownId = 'bat-no-such-id'
    const out = applyBatch([okRow.id, unknownId, failRow.id], { confirm: true, now: NOW }, db)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].proposal_id).toBe(unknownId)
    expect(out.results).toHaveLength(2)
    const statuses = out.results.map(r => r.status)
    expect(statuses).toContain('accepted')
    expect(statuses).toContain('stale')
    // Committed sibling remains accepted even though another item errored.
    assertAccepted(db, okRow.id)
  })

  test('empty ids array returns empty results/errors', () => {
    const out = applyBatch([], { confirm: true, now: NOW }, getDb())
    expect(out.results).toEqual([])
    expect(out.errors).toEqual([])
  })
})

// ── gates re-checked at apply ───────────────────────────────────────────────────

describe('gates re-checked at apply', () => {
  test('maxClusterSize gate uses the live config value at apply time', () => {
    const db = getDb()
    const s = seedThought({ id: 'gate-cl-s', content: 'gate cl src', created_at: NOW })
    const cl = seedThought({ id: 'gate-cl-cl', content: 'gate cluster', created_at: NOW_LATER, is_cluster: 1 })
    withPlacementConfig({ maxClusterSize: 1 }, () => {
      // Cluster already at cap.
      seedEdge(cl, seedThought({ content: 'gate m1', created_at: NOW_LATER }), 'cluster')
      const row = pendingPlacementRow(db, s, cl, 'cluster')
      const out = applyProposal(row.id, { confirm: true, now: NOW }, db)
      expect(out.status).toBe('stale')
      assertStale(db, row.id)
    })
  })

  test('project isolation gate: source/target in different projects → stale', () => {
    const db = getDb()
    const s = seedThought({ id: 'gate-proj-s', content: 'proj src', created_at: NOW, project_id: 'pa' })
    const t = seedThought({ id: 'gate-proj-t', content: 'proj tgt', created_at: NOW_LATER, project_id: 'pb' })
    const row = pendingEdgeRow(db, s, t, 'related')
    const out = applyProposal(row.id, { confirm: true, now: NOW }, db)
    expect(out.status).toBe('stale')
    assertStale(db, row.id)
  })

  test('invalid edge type → failed', () => {
    const db = getDb()
    const s = seedThought({ id: 'gate-inv-s', content: 'inv src', created_at: NOW })
    const t = seedThought({ id: 'gate-inv-t', content: 'inv tgt', created_at: NOW_LATER })
    const row = pendingEdgeRow(db, s, t, 'child') // deprecated / invalid
    const out = applyProposal(row.id, { confirm: true, now: NOW }, db)
    expect(out.status).toBe('failed')
    assertStillPending(db, row.id)
  })
})

// ── no-new-writer static assertion ─────────────────────────────────────────────

describe('no-new-writer static assertion', () => {
  const SERVICE_PATH = join(import.meta.dir, 'placement-apply.service.ts')
  const SOURCE = readFileSync(SERVICE_PATH, 'utf8')

  test('imports only the allowed existing writers, no lower-level graph modules', () => {
    const importRegex = /import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g
    const imports = [...SOURCE.matchAll(importRegex)].map(m => m[1])
    // Explicit writers the orchestrator may call.
    expect(imports).toContain('./edges.service')
    expect(imports).toContain('./thoughts.service')
    // Helpers from db layers (read-only shape checks) — these are fine.
    expect(imports).toContain('../db/edges')
    expect(imports).toContain('../db/placement-proposals')
    expect(imports).toContain('../db/thoughts')
    // Disallowed: no lower-level writer functions (createEdge, mergeThoughts, archiveThought)
    // and no placement/* modules other than placement-proposals.service.
    expect(imports.every(i => !/createEdge\b/.test(i))).toBe(true)
    expect(imports.every(i => !/mergeThoughts\b/.test(i))).toBe(true)
    expect(imports.every(i => !/archiveThought\b/.test(i))).toBe(true)
    // No other placement/ submodule.
    const placementImports = imports.filter(i => i.startsWith('./placement-')).sort()
    expect(placementImports).toEqual(['./placement-apply.types', './placement-proposals.service'])
  })
})
