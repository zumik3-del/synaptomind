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
  applyBatchService,
  applyProposalService,
  MAX_EDGE_ITEMS_PER_RUN
} from './placement-apply.service'
import type { ApplyResult } from './placement-apply.types'
import { computeFingerprint } from './placement-proposals.service'

beforeEach(createTestDb)
afterEach(closeDb)

const NOW = '2026-01-01T00:00:00.000Z'
const NOW_LATER = '2026-02-01T00:00:00.000Z'

function withPlacementConfig(overrides: Partial<typeof config.placement>, fn: () => void): void {
  const saved = config.placement
  config.placement = { ...saved, ...overrides }
  try {
    fn()
  } finally {
    config.placement = saved
  }
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
    existingEdgeType: existing?.type ?? null
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
    ...overrides
  })
}

function pendingLegacyRow(
  db: Database,
  itemKind: 'placement' | 'lifecycle' | 'triage_activate' | 'triage_archive',
  sourceId: string,
  targetId: string | null,
  options: { edgeType?: string | null; lifecycleAction?: string | null } = {}
): PlacementProposalRow {
  const id = Bun.randomUUIDv7()
  const fingerprint = targetId ? pairFingerprint(db, sourceId, targetId) : 'fp-lc'
  db.prepare(`
    INSERT INTO placement_proposals
      (id, project_id, source_thought_id, item_kind, target_id, edge_type, lifecycle_action, direction,
       confidence, rationale, rule_id, payload, state, fingerprint, created_at)
    VALUES (?, 'default', ?, ?, ?, ?, ?, ?, 0.9, ?, null, '{}', 'pending', ?, ?)
  `).run(
    id,
    sourceId,
    itemKind,
    targetId,
    options.edgeType ?? null,
    options.lifecycleAction ?? null,
    itemKind === 'placement' ? 'directed' : null,
    `${itemKind} legacy row`,
    fingerprint,
    NOW
  )
  return db
    .prepare('SELECT * FROM placement_proposals WHERE id = ?')
    .get(id) as PlacementProposalRow
}

function assertStillPending(db: Database, id: string): void {
  const row = db.prepare('SELECT state FROM placement_proposals WHERE id = ?').get(id) as
    | { state: string }
    | undefined
  expect(row).toBeDefined()
  expect(row!.state).toBe('pending')
}

function assertAccepted(db: Database, id: string): void {
  const row = db.prepare('SELECT state FROM placement_proposals WHERE id = ?').get(id) as
    | { state: string }
    | undefined
  expect(row).toBeDefined()
  expect(row!.state).toBe('accepted')
}

function assertStale(db: Database, id: string): void {
  const row = db.prepare('SELECT state FROM placement_proposals WHERE id = ?').get(id) as
    | { state: string }
    | undefined
  expect(row).toBeDefined()
  expect(row!.state).toBe('stale')
}

/** The stored run envelope — the `rollback(run_id)` manifest key (F-28). */
function storedRunId(db: Database, id: string): string | null {
  const row = db.prepare('SELECT run_id FROM placement_proposals WHERE id = ?').get(id) as
    | { run_id: string | null }
    | undefined
  if (!row) throw new Error(`proposal '${id}' not found`)
  return row.run_id
}

function edgeCount(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }).n
}

function pendingEdgeRows(db: Database, count: number, prefix: string): PlacementProposalRow[] {
  const rows: PlacementProposalRow[] = []
  for (let i = 0; i < count; i++) {
    const s = seedThought({
      id: `${prefix}-s-${i}`,
      content: `${prefix} source ${i}`,
      created_at: NOW
    })
    const t = seedThought({
      id: `${prefix}-t-${i}`,
      content: `${prefix} target ${i}`,
      created_at: NOW_LATER
    })
    rows.push(pendingEdgeRow(db, s, t, 'related'))
  }
  return rows
}

describe('conflict matrix', () => {
  test('symmetric edge duplicate (already exists in same direction) → idempotent success', () => {
    const db = getDb()
    const s = seedThought({ id: 'cm-sym-s', content: 'sym src', created_at: NOW })
    const t = seedThought({ id: 'cm-sym-t', content: 'sym tgt', created_at: NOW_LATER })
    seedEdge(s, t, 'related')
    const row = pendingEdgeRow(db, s, t, 'related')
    const out = applyProposalService(row.id, { confirm: true, now: NOW }, db) as Extract<
      ApplyResult,
      { status: 'accepted' }
    >
    expect(out.status).toBe('accepted')
    expect(out.idempotent).toBe(true)
    assertAccepted(db, row.id)
  })

  test('symmetric edge duplicate in reverse direction → idempotent success', () => {
    const db = getDb()
    const s = seedThought({ id: 'cm-sym-r-s', content: 'sym rev src', created_at: NOW })
    const t = seedThought({ id: 'cm-sym-r-t', content: 'sym rev tgt', created_at: NOW_LATER })
    seedEdge(s, t, 'related')
    const row = pendingEdgeRow(db, t, s, 'related')
    const out = applyProposalService(row.id, { confirm: true, now: NOW }, db) as Extract<
      ApplyResult,
      { status: 'accepted' }
    >
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
    const out = applyProposalService(row.id, { confirm: true, now: NOW }, db) as Extract<
      ApplyResult,
      { status: 'accepted' }
    >
    expect(out.status).toBe('accepted')
    expect(out.idempotent).toBe(true)
    assertAccepted(db, row.id)
  })

  test('reverse directed conflict → stale', () => {
    const db = getDb()
    const s = seedThought({ id: 'cm-rev-s', content: 'rev src', created_at: NOW })
    const t = seedThought({ id: 'cm-rev-t', content: 'rev tgt', created_at: NOW_LATER })
    seedEdge(s, t, 'supports')
    const row = pendingEdgeRow(db, t, s, 'supports')
    const out = applyProposalService(row.id, { confirm: true, now: NOW }, db)
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
    const out = applyProposalService(row.id, { confirm: true, now: NOW }, db)
    expect(out.status).toBe('stale')
    assertStale(db, row.id)
  })

  test('archived target → stale', () => {
    const db = getDb()
    const s = seedThought({ id: 'cm-arch-s', content: 'arch src', created_at: NOW })
    const t = seedThought({
      id: 'cm-arch-t',
      content: 'arch tgt',
      created_at: NOW_LATER,
      status: 'archived'
    })
    const row = pendingEdgeRow(db, s, t, 'related')
    const out = applyProposalService(row.id, { confirm: true, now: NOW }, db)
    expect(out.status).toBe('stale')
    assertStale(db, row.id)
  })

  test('a stored placement row from an older install → typed refusal, not a crash', () => {
    const db = getDb()
    const s = seedThought({ id: 'cm-legacy-p-s', content: 'legacy placement src', created_at: NOW })
    const t = seedThought({
      id: 'cm-legacy-p-t',
      content: 'legacy placement tgt',
      created_at: NOW_LATER
    })
    const row = pendingLegacyRow(db, 'placement', s, t, { edgeType: 'parent' })
    const out = applyProposalService(row.id, { confirm: true, now: NOW }, db)
    expect(out.status).toBe('refused')
    const refusal = (out as { refusal: { code: string; reason: string } }).refusal
    expect(refusal.code).toBe('unsupported_item_kind')
    expect(refusal.reason).toContain('placement')
    assertStillPending(db, row.id)
    expect(getEdgePairBetween(db, s, t)).toBeNull()
  })

  test('a stored lifecycle/replaces+archive row from an older install → typed refusal', () => {
    const db = getDb()
    const s = seedThought({ id: 'cm-legacy-l-s', content: 'legacy lifecycle src', created_at: NOW })
    const t = seedThought({
      id: 'cm-legacy-l-t',
      content: 'legacy lifecycle tgt',
      created_at: NOW_LATER
    })
    const row = pendingLegacyRow(db, 'lifecycle', s, t, {
      edgeType: 'replaces',
      lifecycleAction: 'replaces+archive'
    })
    const out = applyProposalService(row.id, { confirm: true, now: NOW }, db)
    expect(out.status).toBe('refused')
    const refusal = (out as { refusal: { code: string; reason: string } }).refusal
    expect(refusal.code).toBe('unsupported_item_kind')
    expect(refusal.reason).toContain('lifecycle')
    assertStillPending(db, row.id)
    expect(getThoughtRow(db, t)!.status).toBe('active')
  })

  test('a stored triage_activate row from an older install → typed refusal, not a downgrade to stale', () => {
    const db = getDb()
    const s = seedThought({
      id: 'cm-legacy-ta-s',
      content: 'legacy triage activate src',
      created_at: NOW
    })
    const row = pendingLegacyRow(db, 'triage_activate', s, null)
    const out = applyProposalService(row.id, { confirm: true, now: NOW }, db)
    expect(out.status).toBe('refused')
    const refusal = (out as { refusal: { code: string; reason: string } }).refusal
    expect(refusal.code).toBe('unsupported_item_kind')
    expect(refusal.reason).toContain('triage_activate')
    assertStillPending(db, row.id)
    expect(edgeCount(db)).toBe(0)
  })

  test('a stored triage_archive row from an older install → typed refusal and no archive write', () => {
    const db = getDb()
    const s = seedThought({
      id: 'cm-legacy-tar-s',
      content: 'legacy triage archive src',
      created_at: NOW
    })
    const t = seedThought({
      id: 'cm-legacy-tar-t',
      content: 'legacy triage archive tgt',
      created_at: NOW_LATER
    })
    const row = pendingLegacyRow(db, 'triage_archive', s, t)
    const out = applyProposalService(row.id, { confirm: true, now: NOW }, db)
    expect(out.status).toBe('refused')
    const refusal = (out as { refusal: { code: string; reason: string } }).refusal
    expect(refusal.code).toBe('unsupported_item_kind')
    expect(refusal.reason).toContain('triage_archive')
    assertStillPending(db, row.id)
    expect(getThoughtRow(db, s)!.status).toBe('active')
    expect(getThoughtRow(db, t)!.status).toBe('active')
    expect(edgeCount(db)).toBe(0)
  })

  test('cluster edge whose source is not a cluster → failed', () => {
    const db = getDb()
    const s = seedThought({ id: 'cm-cl-s', content: 'cl src', created_at: NOW })
    const t = seedThought({ id: 'cm-cl-t', content: 'cl tgt', created_at: NOW_LATER })
    const row = pendingEdgeRow(db, s, t, 'cluster')
    const out = applyProposalService(row.id, { confirm: true, now: NOW }, db)
    expect(out.status).toBe('failed')
    assertStillPending(db, row.id)
  })

  test('cluster edge exceeding maxClusterSize → stale', () => {
    const db = getDb()
    const cl = seedThought({
      id: 'cm-clap-cl',
      content: 'the cluster',
      created_at: NOW,
      is_cluster: 1
    })
    const m = seedThought({ id: 'cm-clap-m', content: 'new member', created_at: NOW_LATER })
    withPlacementConfig({ maxClusterSize: 2 }, () => {
      seedEdge(cl, seedThought({ content: 'm1', created_at: NOW_LATER }), 'cluster')
      seedEdge(cl, seedThought({ content: 'm2', created_at: NOW_LATER }), 'cluster')
      const row = pendingEdgeRow(db, cl, m, 'cluster')
      const out = applyProposalService(row.id, { confirm: true, now: NOW }, db)
      expect(out.status).toBe('stale')
      assertStale(db, row.id)
    })
  })

  test('unknown proposal id throws NotFoundError', () => {
    expect(() => applyProposalService('no-such-id', { confirm: true, now: NOW }, getDb())).toThrow(
      NotFoundError
    )
  })
})

describe('idempotency', () => {
  test('re-applying an already-accepted row returns accepted/idempotent without calling a writer', () => {
    const db = getDb()
    const s = seedThought({ id: 'id-s', content: 'idem src', created_at: NOW })
    const t = seedThought({ id: 'id-t', content: 'idem tgt', created_at: NOW_LATER })
    const row = pendingEdgeRow(db, s, t, 'related')
    applyProposalService(row.id, { confirm: true, now: NOW }, db)
    assertAccepted(db, row.id)
    const out = applyProposalService(row.id, { confirm: true, now: NOW_LATER }, db) as Extract<
      ApplyResult,
      { status: 'accepted' }
    >
    expect(out.status).toBe('accepted')
    expect(out.idempotent).toBe(true)
    expect(out.calls).toEqual([])
    assertAccepted(db, row.id)
  })

  test('re-applying a pending row whose effect already landed externally → idempotent success', () => {
    const db = getDb()
    const s = seedThought({ id: 'id-ext-s', content: 'ext src', created_at: NOW })
    const t = seedThought({ id: 'id-ext-t', content: 'ext tgt', created_at: NOW_LATER })
    seedEdge(s, t, 'supports')
    const row = pendingEdgeRow(db, s, t, 'supports')
    const out = applyProposalService(row.id, { confirm: true, now: NOW }, db) as Extract<
      ApplyResult,
      { status: 'accepted' }
    >
    expect(out.status).toBe('accepted')
    expect(out.idempotent).toBe(true)
    assertAccepted(db, row.id)
  })
})

describe('dry-run (confirm:false / absent)', () => {
  test('dry-run returns calls without mutating the queue or the graph', () => {
    const db = getDb()
    const s = seedThought({ id: 'dr-s', content: 'dry src', created_at: NOW })
    const t = seedThought({ id: 'dr-t', content: 'dry tgt', created_at: NOW_LATER })
    const row = pendingEdgeRow(db, s, t, 'develops')
    const out = applyProposalService(row.id, { now: NOW }, db)
    expect(out.status).toBe('dry_run')
    expect((out as Extract<ApplyResult, { status: 'dry_run' }>).calls).toHaveLength(1)
    assertStillPending(db, row.id)
    const edge = db
      .prepare('SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND type = ?')
      .get(s, t, 'develops')
    expect(edge).toBeNull()
  })

  test('dry-run still surfaces stale/failed gates without mutating the queue', () => {
    const db = getDb()
    const s = seedThought({ id: 'dr-stale-s', content: 'stale src', created_at: NOW })
    const t = seedThought({
      id: 'dr-stale-t',
      content: 'stale tgt',
      created_at: NOW_LATER,
      status: 'archived'
    })
    const row = pendingEdgeRow(db, s, t, 'related')
    const out = applyProposalService(row.id, { now: NOW }, db)
    expect(out.status).toBe('stale')
    assertStillPending(db, row.id)
  })

  test('explicit confirm:false behaves like the default (no mutation)', () => {
    const db = getDb()
    const s = seedThought({ id: 'dr-exp-s', content: 'exp src', created_at: NOW })
    const t = seedThought({ id: 'dr-exp-t', content: 'exp tgt', created_at: NOW_LATER })
    const row = pendingEdgeRow(db, s, t, 'related')
    const out = applyProposalService(row.id, { confirm: false, now: NOW }, db)
    expect(out.status).toBe('dry_run')
    assertStillPending(db, row.id)
  })
})

describe('atomicity: writer throws', () => {
  test('a writer throw rolls back the graph and lands the row as failed (not accepted)', () => {
    const db = getDb()
    const s = seedThought({ id: 'at-s', content: 'atomic src', created_at: NOW })
    const cl = seedThought({
      id: 'at-cl',
      content: 'atomic cluster',
      created_at: NOW_LATER,
      is_cluster: 1
    })
    const row = pendingEdgeRow(db, s, cl, 'references')
    const beforeEdges = db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }
    const out = applyProposalService(row.id, { confirm: true, now: NOW }, db)
    expect(out.status).toBe('failed')
    const afterEdges = db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }
    expect(afterEdges.n).toBe(beforeEdges.n)
    assertStillPending(db, row.id)
  })
})

describe('applyBatchService: partial failure independence', () => {
  test('commits siblings while collecting errors for broken ids', () => {
    const db = getDb()
    const s1 = seedThought({ id: 'bat-s1', content: 'batch s1', created_at: NOW })
    const t1 = seedThought({ id: 'bat-t1', content: 'batch t1', created_at: NOW_LATER })
    const s2 = seedThought({ id: 'bat-s2', content: 'batch s2', created_at: NOW })
    const t2 = seedThought({
      id: 'bat-t2',
      content: 'batch t2',
      created_at: NOW_LATER,
      status: 'archived'
    })
    const okRow = pendingEdgeRow(db, s1, t1, 'related')
    const failRow = pendingEdgeRow(db, s2, t2, 'related')
    const unknownId = 'bat-no-such-id'
    const out = applyBatchService(
      [okRow.id, unknownId, failRow.id],
      { confirm: true, now: NOW },
      db
    )
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].proposal_id).toBe(unknownId)
    expect(out.results).toHaveLength(2)
    const statuses = out.results.map(r => r.status)
    expect(statuses).toContain('accepted')
    expect(statuses).toContain('stale')
    assertAccepted(db, okRow.id)

    const shared = out.run_id ?? null
    expect(typeof shared).toBe('string')
    expect(shared!.startsWith('auto-')).toBe(true)
    const accepted = out.results.find(r => r.proposal_id === okRow.id) as Extract<
      ApplyResult,
      { status: 'accepted' }
    >
    expect(accepted.status).toBe('accepted')
    expect(accepted.run_id).toBe(shared)
    expect(storedRunId(db, okRow.id)).toBe(shared)
    const stale = out.results.find(r => r.proposal_id === failRow.id)!
    expect(stale.status).toBe('stale')
    expect('run_id' in stale).toBe(false)
    expect(storedRunId(db, failRow.id)).toBeNull()
  })

  test('empty ids array returns empty results/errors', () => {
    const out = applyBatchService([], { confirm: true, now: NOW }, getDb())
    expect(out.results).toEqual([])
    expect(out.errors).toEqual([])
  })
})

describe('applyBatchService: per-call limit (task #1962)', () => {
  test('a batch over the caller limit is refused whole and applies nothing', () => {
    const db = getDb()
    const rows = pendingEdgeRows(db, 2, 'lim-over')

    const out = applyBatchService(
      rows.map(r => r.id),
      { confirm: true, now: NOW, limit: 1 },
      db
    )

    expect(out.refused?.code).toBe('limit_exceeded')
    expect(out.refused?.reason).toContain('limit is 1')
    expect(out.results).toEqual([])
    expect(out.errors).toEqual([])
    for (const row of rows) assertStillPending(db, row.id)
    expect(edgeCount(db)).toBe(0)
  })

  test('a batch exactly at the caller limit applies every item', () => {
    const db = getDb()
    const rows = pendingEdgeRows(db, 2, 'lim-at')

    const out = applyBatchService(
      rows.map(r => r.id),
      { confirm: true, now: NOW, limit: 2 },
      db
    )

    expect(out.refused).toBeUndefined()
    expect(out.results).toHaveLength(2)
    expect(out.results.every(r => r.status === 'accepted')).toBe(true)
    expect(edgeCount(db)).toBe(2)
  })
})

describe('applyBatchService: per-run edge cap (task #1962)', () => {
  test('a run of exactly MAX_EDGE_ITEMS_PER_RUN edge items applies', () => {
    const db = getDb()
    const rows = pendingEdgeRows(db, MAX_EDGE_ITEMS_PER_RUN, 'cap-at')

    const out = applyBatchService(
      rows.map(r => r.id),
      { confirm: true, now: NOW },
      db
    )

    expect(out.refused).toBeUndefined()
    expect(out.results).toHaveLength(MAX_EDGE_ITEMS_PER_RUN)
    expect(out.results.every(r => r.status === 'accepted')).toBe(true)
    expect(edgeCount(db)).toBe(MAX_EDGE_ITEMS_PER_RUN)
  })

  test('a run one past MAX_EDGE_ITEMS_PER_RUN is refused whole and writes nothing', () => {
    const db = getDb()
    const rows = pendingEdgeRows(db, MAX_EDGE_ITEMS_PER_RUN + 1, 'cap-over')

    const out = applyBatchService(
      rows.map(r => r.id),
      { confirm: true, now: NOW },
      db
    )

    expect(out.refused?.code).toBe('limit_exceeded')
    expect(out.refused?.reason).toContain('per-run cap')
    expect(out.results).toEqual([])
    expect(out.errors).toEqual([])
    for (const row of rows) assertStillPending(db, row.id)
    expect(edgeCount(db)).toBe(0)
  })

  test('an explicit limit above the cap does not lift it, and a dry-run reports the same verdict', () => {
    const db = getDb()
    const ids = pendingEdgeRows(db, MAX_EDGE_ITEMS_PER_RUN + 1, 'cap-limit').map(r => r.id)

    const preview = applyBatchService(ids, { now: NOW, limit: 100 }, db)
    expect(preview.refused?.code).toBe('limit_exceeded')
    expect(preview.refused?.reason).toContain('per-run cap')

    const confirmed = applyBatchService(ids, { confirm: true, now: NOW, limit: 100 }, db)
    expect(confirmed.refused?.reason).toBe(preview.refused?.reason)
    expect(confirmed.results).toEqual([])
    expect(edgeCount(db)).toBe(0)
  })

  test('rows that write no edge do not count toward the cap', () => {
    const db = getDb()
    const rows = pendingEdgeRows(db, MAX_EDGE_ITEMS_PER_RUN, 'cap-free')
    const extra = pendingEdgeRows(db, 1, 'cap-free-extra')[0]
    expect(applyProposalService(extra.id, { confirm: true, now: NOW }, db).status).toBe('accepted')

    const out = applyBatchService(
      [...rows.map(r => r.id), extra.id],
      { confirm: true, now: NOW },
      db
    )

    expect(out.refused).toBeUndefined()
    expect(out.results).toHaveLength(MAX_EDGE_ITEMS_PER_RUN + 1)
    expect(out.results.find(r => r.proposal_id === extra.id)).toMatchObject({
      status: 'accepted',
      idempotent: true
    })
    expect(
      out.results.filter(r => r.proposal_id !== extra.id).every(r => r.status === 'accepted')
    ).toBe(true)
  })
})

describe('gates re-checked at apply', () => {
  test('maxClusterSize gate uses the live config value at apply time', () => {
    const db = getDb()
    const cl = seedThought({
      id: 'gate-cl-cl',
      content: 'gate cluster',
      created_at: NOW,
      is_cluster: 1
    })
    const m = seedThought({ id: 'gate-cl-m', content: 'gate member', created_at: NOW_LATER })
    withPlacementConfig({ maxClusterSize: 1 }, () => {
      seedEdge(cl, seedThought({ content: 'gate m1', created_at: NOW_LATER }), 'cluster')
      const row = pendingEdgeRow(db, cl, m, 'cluster')
      const out = applyProposalService(row.id, { confirm: true, now: NOW }, db)
      expect(out.status).toBe('stale')
      assertStale(db, row.id)
    })
  })

  test('project isolation gate: source/target in different projects → stale', () => {
    const db = getDb()
    const s = seedThought({
      id: 'gate-proj-s',
      content: 'proj src',
      created_at: NOW,
      project_id: 'pa'
    })
    const t = seedThought({
      id: 'gate-proj-t',
      content: 'proj tgt',
      created_at: NOW_LATER,
      project_id: 'pb'
    })
    const row = pendingEdgeRow(db, s, t, 'related')
    const out = applyProposalService(row.id, { confirm: true, now: NOW }, db)
    expect(out.status).toBe('stale')
    assertStale(db, row.id)
  })

  test('invalid edge type → failed', () => {
    const db = getDb()
    const s = seedThought({ id: 'gate-inv-s', content: 'inv src', created_at: NOW })
    const t = seedThought({ id: 'gate-inv-t', content: 'inv tgt', created_at: NOW_LATER })
    const row = pendingEdgeRow(db, s, t, 'child')
    const out = applyProposalService(row.id, { confirm: true, now: NOW }, db)
    expect(out.status).toBe('failed')
    assertStillPending(db, row.id)
  })
})

describe('no-new-writer static assertion', () => {
  const SERVICE_PATH = join(import.meta.dir, 'placement-apply.service.ts')
  const SOURCE = readFileSync(SERVICE_PATH, 'utf8')

  test('imports only the allowed existing writers, no lower-level graph modules', () => {
    const importRegex = /import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g
    const imports = [...SOURCE.matchAll(importRegex)].map(m => m[1])
    expect(imports).toContain('./edges.service')
    expect(imports).toContain('../db/placement-proposals')
    expect(imports.every(i => !/createEdge\b/.test(i))).toBe(true)
    expect(imports.every(i => !/mergeThoughts\b/.test(i))).toBe(true)
    expect(imports.every(i => !/archiveThought\b/.test(i))).toBe(true)
    const placementImports = imports.filter(i => i.startsWith('./placement-')).sort()
    expect(placementImports).toEqual(['./placement-apply.types', './placement-proposals.service'])
  })
})
