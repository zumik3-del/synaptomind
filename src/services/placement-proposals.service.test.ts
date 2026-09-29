/**
 * P8 queue-service tests (task #973, epic #964; service authored in #971).
 *
 * Verifies `src/services/placement-proposals.service.ts`: plan → row mapping
 * (edge / placement / lifecycle shapes; replaces+archive owns its pair; keep /
 * link emit no lifecycle item), dedup refresh, fingerprint / staleness,
 * maxPendingProposals cap, list defaults, reject, draft guard, determinism, and
 * the regression that proposePlacementPlan leaves placement_proposals empty.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { closeDb, getDb } from '../db'
import { insertProposal, updateProposalState, type PlacementProposalRow } from '../db/placement-proposals'
import { NotFoundError, ValidationError } from '../errors'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { DRAFT_THOUGHT_ID, proposePlacementPlan } from './placement/engine'
import {
  computeFingerprint,
  enqueuePlan,
  isProposalStale,
  list,
  reject,
} from './placement-proposals.service'
import type {
  EdgeProposal,
  LifecycleAction,
  LifecycleProposal,
  PairSignals,
  PlacementPlan,
  PlacementProposal,
} from './placement/types'

beforeEach(createTestDb)
afterEach(closeDb)

const NOW = '2026-01-01T00:00:00.000Z'
const NOW_LATER = '2026-02-01T00:00:00.000Z'
const T_SRC = NOW
const T_TGT = '2025-01-01T00:00:00.000Z'

// ── helpers ───────────────────────────────────────────────────────────────────

function baseSignals(sourceId: string, targetId: string): PairSignals {
  return {
    sourceId,
    targetId,
    embeddingSimilarity: 0.9,
    lexicalOverlap: 0.1,
    negationDelta: 0,
    evidentialCue: false,
    evolutionCue: false,
    temporalOrder: 'newer',
    tagOverlap: 0,
    dependencyCue: false,
    existingEdgeType: null,
    sourceStatus: 'active',
    targetStatus: 'active',
    sourceStanding: 'current',
    targetStanding: 'current',
    sameProject: true,
  }
}

function makeEdge(sourceId: string, targetId: string, overrides: Partial<EdgeProposal> = {}): EdgeProposal {
  return {
    source_id: sourceId,
    target_id: targetId,
    type: 'related',
    direction: 'symmetric',
    confidence: 0.9,
    rationale: 'edge rationale',
    review_required: false,
    rule_id: 'fallback.embedding_related',
    signals: baseSignals(sourceId, targetId),
    ...overrides,
  }
}

function makePlacement(targetId: string, kind: PlacementProposal['kind'] = 'cluster', overrides: Partial<PlacementProposal> = {}): PlacementProposal {
  return {
    kind,
    target_id: targetId,
    confidence: 0.7,
    rationale: 'placement rationale',
    review_required: true,
    ...overrides,
  }
}

function makeLifecycle(action: LifecycleAction, overrides: Partial<LifecycleProposal> = {}): LifecycleProposal {
  return {
    action,
    confidence: 0.8,
    rationale: `lifecycle ${action}`,
    review_required: action !== 'keep',
    blocked_by: [],
    ...overrides,
  }
}

function edgePlan(sourceId: string, targetId: string, overrides: Partial<EdgeProposal> = {}): PlacementPlan {
  return {
    thought_id: sourceId,
    placement: null,
    edges: [makeEdge(sourceId, targetId, overrides)],
    lifecycle: makeLifecycle('keep'),
    degraded: false,
    generated_at: NOW,
  }
}

/** Save/restore `config.placement` across a callback. */
function withPlacementConfig(overrides: Partial<typeof config.placement>, fn: () => void): void {
  const saved = config.placement
  config.placement = { ...saved, ...overrides }
  try {
    fn()
  } finally {
    config.placement = saved
  }
}

function queueRowCount(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM placement_proposals').get() as { n: number }).n
}

function okEmbed(_texts: string[]): Promise<Float32Array[]> {
  return Promise.resolve(_texts.map(() => new Float32Array(384)))
}

// ── computeFingerprint ───────────────────────────────────────────────────────

describe('computeFingerprint', () => {
  const base = {
    sourceId: 's',
    sourceUpdatedAt: T_SRC,
    sourceStatus: 'active',
    targetId: 't',
    targetUpdatedAt: T_TGT,
    targetStatus: 'active',
    existingEdgeType: null,
  }

  test('same inputs produce the same digest', () => {
    expect(computeFingerprint(base)).toBe(computeFingerprint({ ...base }))
  })

  test('null existingEdgeType is normalised to "none"', () => {
    expect(computeFingerprint({ ...base, existingEdgeType: null })).toBe(
      computeFingerprint({ ...base, existingEdgeType: 'none' })
    )
  })

  test('different updated_at / status / edge type yield distinct digests', () => {
    const a = computeFingerprint({ ...base, sourceUpdatedAt: '2026-06-01T00:00:00.000Z' })
    const b = computeFingerprint({ ...base, sourceStatus: 'archived' })
    const c = computeFingerprint({ ...base, existingEdgeType: 'supports' })
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
    expect(b).not.toBe(c)
  })
})

// ── Mapping: each plan shape → expected rows ──────────────────────────────────

describe('enqueuePlan: plan → row mapping', () => {
  test('edge-only plan maps to a single edge row', () => {
    const db = getDb()
    const src = seedThought({ id: 'map-src', content: 'map source', created_at: T_SRC })
    const tgt = seedThought({ id: 'map-tgt', content: 'map target', created_at: T_TGT })
    const plan = edgePlan(src, tgt, {
      type: 'supports',
      direction: 'directed',
      rule_id: 'evidence.cue_supports',
      confidence: 0.85,
      rationale: 'supports this',
      review_required: true,
    })
    const rows = enqueuePlan(plan, { now: NOW }, db)
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.state).toBe('pending')
    expect(r.project_id).toBe('default')
    expect(r.item_kind).toBe('edge')
    expect(r.source_thought_id).toBe(src)
    expect(r.target_id).toBe(tgt)
    expect(r.edge_type).toBe('supports')
    expect(r.lifecycle_action).toBeNull()
    expect(r.direction).toBe('directed')
    expect(r.confidence).toBe(0.85)
    expect(r.rationale).toBe('supports this')
    expect(r.rule_id).toBe('evidence.cue_supports')
    const payload = JSON.parse(r.payload) as Record<string, unknown>
    expect(payload.review_required).toBe(true)
    expect(payload.signals).toEqual(plan.edges[0].signals)
    expect(r.fingerprint).toBe(
      computeFingerprint({ sourceId: src, sourceUpdatedAt: T_SRC, sourceStatus: 'active', targetId: tgt, targetUpdatedAt: T_TGT, targetStatus: 'active', existingEdgeType: null })
    )
    expect(r.expires_at).toBe(new Date(Date.parse(NOW) + config.placement.proposalTtlDays * 86400_000).toISOString())
    expect(queueRowCount(db)).toBe(1)
  })

  test('placement (cluster) → one placement row with edge_type=cluster', () => {
    const db = getDb()
    const src = seedThought({ id: 'cl-src', content: 'cluster source', created_at: T_SRC })
    const cl = seedThought({ id: 'cl-target', content: 'the cluster', is_cluster: 1, created_at: T_TGT })
    const plan: PlacementPlan = {
      thought_id: src,
      placement: makePlacement(cl, 'cluster'),
      edges: [],
      lifecycle: makeLifecycle('keep'),
      degraded: false,
      generated_at: NOW,
    }
    const rows = enqueuePlan(plan, { now: NOW }, db)
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.item_kind).toBe('placement')
    expect(r.edge_type).toBe('cluster')
    expect(r.lifecycle_action).toBeNull()
    expect(r.direction).toBe('directed')
    expect(r.rule_id).toBeNull()
    expect(r.rationale).toBe('placement rationale')
    const payload = JSON.parse(r.payload) as Record<string, unknown>
    expect(payload.kind).toBe('cluster')
    expect(payload.review_required).toBe(true)
  })

  test('placement (parent) → one placement row with edge_type=parent', () => {
    const db = getDb()
    const src = seedThought({ id: 'pp-src', content: 'parent placement', created_at: T_SRC })
    const par = seedThought({ id: 'pp-par', content: 'chain node', created_at: T_TGT })
    const plan: PlacementPlan = {
      thought_id: src,
      placement: makePlacement(par, 'parent', { confidence: 0.65, review_required: false }),
      edges: [],
      lifecycle: makeLifecycle('keep'),
      degraded: false,
      generated_at: NOW,
    }
    const rows = enqueuePlan(plan, { now: NOW }, db)
    expect(rows).toHaveLength(1)
    expect(rows[0].item_kind).toBe('placement')
    expect(rows[0].edge_type).toBe('parent')
    expect(rows[0].confidence).toBe(0.65)
    expect(rows[0].rule_id).toBeNull()
  })

  test('merge lifecycle → one lifecycle row with target and null edge_type', () => {
    const db = getDb()
    const src = seedThought({ id: 'mg-src', content: 'merge source', created_at: T_SRC })
    const tgt = seedThought({ id: 'mg-tgt', content: 'merge target', created_at: T_TGT })
    const plan: PlacementPlan = {
      thought_id: src,
      placement: null,
      edges: [],
      lifecycle: makeLifecycle('merge', { target_id: tgt, confidence: 0.95, blocked_by: ['source is protected'] }),
      degraded: false,
      generated_at: NOW,
    }
    const rows = enqueuePlan(plan, { now: NOW }, db)
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.item_kind).toBe('lifecycle')
    expect(r.lifecycle_action).toBe('merge')
    expect(r.target_id).toBe(tgt)
    expect(r.edge_type).toBeNull()
    expect(r.direction).toBeNull()
    expect(r.rule_id).toBeNull()
    const payload = JSON.parse(r.payload) as Record<string, unknown>
    expect(payload.blocked_by).toEqual(['source is protected'])
    expect(payload.review_required).toBe(true)
  })

  test('replaces+archive owns its pair: the replaces edge is not queued a second time', () => {
    const db = getDb()
    const src = seedThought({ id: 'ra-src', content: 'newer', created_at: T_SRC })
    const tgt = seedThought({ id: 'ra-tgt', content: 'older', created_at: T_TGT })
    const plan: PlacementPlan = {
      thought_id: src,
      placement: null,
      edges: [makeEdge(src, tgt, { type: 'replaces', direction: 'directed', rule_id: 'supersede.newer_replaces_older', confidence: 0.9 })],
      lifecycle: makeLifecycle('replaces+archive', { target_id: tgt, confidence: 0.9 }),
      degraded: false,
      generated_at: NOW,
    }
    const rows = enqueuePlan(plan, { now: NOW }, db)
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.item_kind).toBe('lifecycle')
    expect(r.lifecycle_action).toBe('replaces+archive')
    expect(r.edge_type).toBe('replaces')
    expect(r.rule_id).toBe('supersede.newer_replaces_older')
    expect(r.target_id).toBe(tgt)
    expect(r.confidence).toBe(0.9)
    expect(queueRowCount(db)).toBe(1)
  })

  test('replaces+archive without a lifecycle target_id falls back to the replaces edge target', () => {
    const db = getDb()
    const src = seedThought({ id: 'fb-src', content: 'fallback source', created_at: T_SRC })
    const tgt = seedThought({ id: 'fb-tgt', content: 'fallback target', created_at: T_TGT })
    const plan: PlacementPlan = {
      thought_id: src,
      placement: null,
      edges: [makeEdge(src, tgt, { type: 'replaces', rule_id: 'supersede.newer_replaces_older' })],
      lifecycle: makeLifecycle('replaces+archive'), // pre-#971 shape: no target_id
      degraded: false,
      generated_at: NOW,
    }
    const rows = enqueuePlan(plan, { now: NOW }, db)
    expect(rows).toHaveLength(1)
    expect(rows[0].item_kind).toBe('lifecycle')
    expect(rows[0].target_id).toBe(tgt)
    expect(rows[0].lifecycle_action).toBe('replaces+archive')
  })

  test('link lifecycle queues only edge items (no lifecycle row)', () => {
    const db = getDb()
    const src = seedThought({ id: 'lk-src', content: 'link source', created_at: T_SRC })
    const t1 = seedThought({ id: 'lk-t1', content: 'link first', created_at: T_TGT })
    const t2 = seedThought({ id: 'lk-t2', content: 'link second', created_at: T_TGT })
    const plan: PlacementPlan = {
      thought_id: src,
      placement: null,
      edges: [makeEdge(src, t1, { type: 'supports' }), makeEdge(src, t2, { type: 'related' })],
      lifecycle: makeLifecycle('link'),
      degraded: false,
      generated_at: NOW,
    }
    const rows = enqueuePlan(plan, { now: NOW }, db)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.item_kind === 'edge')).toBe(true)
    expect(rows.every((r) => r.lifecycle_action === null)).toBe(true)
  })

  test('keep with no edges/placement → no rows and an untouched queue', () => {
    const db = getDb()
    const src = seedThought({ id: 'kp-src', content: 'keep source', created_at: T_SRC })
    const plan: PlacementPlan = {
      thought_id: src,
      placement: null,
      edges: [],
      lifecycle: makeLifecycle('keep'),
      degraded: false,
      generated_at: NOW,
    }
    const rows = enqueuePlan(plan, { now: NOW }, db)
    expect(rows).toEqual([])
    expect(queueRowCount(db)).toBe(0)
  })

  test('an edge whose target is not persisted is skipped (no row, no throw)', () => {
    const db = getDb()
    const src = seedThought({ id: 'gh-src', content: 'ghost source', created_at: T_SRC })
    const rows = enqueuePlan(edgePlan(src, 'ghost-target'), { now: NOW }, db)
    expect(rows).toEqual([])
    expect(queueRowCount(db)).toBe(0)
  })

  test('TTL disabled (proposalTtlDays < 0) → null expires_at', () => {
    const db = getDb()
    const src = seedThought({ id: 'ttl-src', content: 'ttl source', created_at: T_SRC })
    const tgt = seedThought({ id: 'ttl-tgt', content: 'ttl target', created_at: T_TGT })
    withPlacementConfig({ proposalTtlDays: -1 }, () => {
      const rows = enqueuePlan(edgePlan(src, tgt), { now: NOW }, db)
      expect(rows).toHaveLength(1)
      expect(rows[0].expires_at).toBeNull()
    })
  })

  test('multiple edges + placement → one row per item', () => {
    const db = getDb()
    const src = seedThought({ id: 'mm-src', content: 'multi source', created_at: T_SRC })
    const t1 = seedThought({ id: 'mm-t1', content: 'multi first', created_at: T_TGT })
    const t2 = seedThought({ id: 'mm-t2', content: 'multi second', created_at: T_TGT })
    const cl = seedThought({ id: 'mm-cl', content: 'the cluster', is_cluster: 1, created_at: T_TGT })
    const plan: PlacementPlan = {
      thought_id: src,
      placement: makePlacement(cl, 'cluster'),
      edges: [makeEdge(src, t1), makeEdge(src, t2, { type: 'contradicts', direction: 'directed' })],
      lifecycle: makeLifecycle('link'),
      degraded: false,
      generated_at: NOW,
    }
    const rows = enqueuePlan(plan, { now: NOW }, db)
    expect(rows.map((r) => `${r.item_kind}:${r.target_id}`).sort()).toEqual([
      `edge:${t1}`,
      `edge:${t2}`,
      `placement:${cl}`,
    ].sort())
  })
})

// ── dedup refresh ─────────────────────────────────────────────────────────────

describe('enqueuePlan: dedup refresh', () => {
  test('re-enqueueing the same item refreshes the live row instead of duplicating', () => {
    const db = getDb()
    const src = seedThought({ id: 'dd-src', content: 'dedup source', created_at: T_SRC })
    const tgt = seedThought({ id: 'dd-tgt', content: 'dedup target', created_at: T_TGT })
    const plan = edgePlan(src, tgt, { rationale: 'first pass', confidence: 0.55 })
    const first = enqueuePlan(plan, { now: NOW }, db)[0]

    plan.edges[0].rationale = 'second pass'
    plan.edges[0].confidence = 0.8
    const refreshed = enqueuePlan(plan, { now: NOW_LATER }, db)
    expect(refreshed).toHaveLength(1)
    expect(refreshed[0].id).toBe(first.id)
    expect(refreshed[0].created_at).toBe(first.created_at)
    expect(refreshed[0].rationale).toBe('second pass')
    expect(refreshed[0].confidence).toBe(0.8)
    expect(refreshed[0].expires_at).toBe(new Date(Date.parse(NOW_LATER) + 30 * 86400_000).toISOString())
    expect(queueRowCount(db)).toBe(1)
    expect(list({ now: NOW_LATER }, db)).toHaveLength(1)
  })

  test('re-enqueue after a graph mutation recomputes the fingerprint but keeps one row', () => {
    const db = getDb()
    const src = seedThought({ id: 'rf-src', content: 'refresh-stale source', created_at: T_SRC })
    const tgt = seedThought({ id: 'rf-tgt', content: 'refresh-stale target', created_at: T_TGT })
    const plan = edgePlan(src, tgt)
    const first = enqueuePlan(plan, { now: NOW }, db)[0]
    db.prepare('UPDATE thoughts SET status = ? WHERE id = ?').run('archived', src)
    const refreshed = enqueuePlan(plan, { now: NOW_LATER }, db)
    expect(refreshed).toHaveLength(1)
    expect(refreshed[0].id).toBe(first.id)
    expect(refreshed[0].fingerprint).not.toBe(first.fingerprint)
    expect(refreshed[0].fingerprint).toBe(
      computeFingerprint({ sourceId: src, sourceUpdatedAt: T_SRC, sourceStatus: 'archived', targetId: tgt, targetUpdatedAt: T_TGT, targetStatus: 'active', existingEdgeType: null })
    )
  })
})

// ── fingerprint / staleness ───────────────────────────────────────────────────

describe('isProposalStale', () => {
  interface Fixture { db: Database; src: string; tgt: string; row: PlacementProposalRow }
  function fixture(edgeOpts: Partial<EdgeProposal> = {}, withExistingEdge: string | null = null): Fixture {
    const db = getDb()
    const src = seedThought({ id: 'sl-src', content: 'staleness source', created_at: T_SRC })
    const tgt = seedThought({ id: 'sl-tgt', content: 'staleness target', created_at: T_TGT })
    if (withExistingEdge) seedEdge(src, tgt, withExistingEdge)
    const rows = enqueuePlan(edgePlan(src, tgt, edgeOpts), { now: NOW }, db)
    return { db, src, tgt, row: rows[0] }
  }

  test('an unchanged snapshot stays fresh', () => {
    const f = fixture()
    expect(isProposalStale(f.row, f.db)).toBe(false)
  })

  const mutations: Array<{ label: string; apply: (f: Fixture) => void }> = [
    { label: 'source.updated_at changes', apply: (f) => f.db.prepare('UPDATE thoughts SET updated_at = ? WHERE id = ?').run('2026-06-01T00:00:00.000Z', f.src) },
    { label: 'source.status changes', apply: (f) => f.db.prepare('UPDATE thoughts SET status = ? WHERE id = ?').run('draft', f.src) },
    { label: 'target.updated_at changes', apply: (f) => f.db.prepare('UPDATE thoughts SET updated_at = ? WHERE id = ?').run('2026-06-01T00:00:00.000Z', f.tgt) },
    { label: 'target.status changes', apply: (f) => f.db.prepare('UPDATE thoughts SET status = ? WHERE id = ?').run('archived', f.tgt) },
    { label: 'a new edge appears on the pair', apply: (f) => seedEdge(f.src, f.tgt, 'contradicts') },
  ]
  for (const { label, apply } of mutations) {
    test(`${label} → stale`, () => {
      const f = fixture()
      apply(f)
      expect(isProposalStale(f.row, f.db)).toBe(true)
    })
  }

  test('the existing edge type flipping on the pair → stale', () => {
    const f = fixture({}, 'supports')
    const edge = f.db.prepare('SELECT id FROM edges WHERE source_id = ? AND target_id = ?').get(f.src, f.tgt) as { id: string }
    f.db.prepare('UPDATE edges SET type = ? WHERE id = ?').run('contradicts', edge.id)
    expect(isProposalStale(f.row, f.db)).toBe(true)
  })

  test('a missing target thought → stale', () => {
    const f = fixture()
    f.db.prepare('DELETE FROM thoughts WHERE id = ?').run(f.tgt)
    expect(isProposalStale(f.row, f.db)).toBe(true)
  })

  test('a missing source thought → stale', () => {
    const f = fixture()
    f.db.prepare('DELETE FROM thoughts WHERE id = ?').run(f.src)
    expect(isProposalStale(f.row, f.db)).toBe(true)
  })

  test('a lifecycle row goes stale when a new edge appears on its merge pair', () => {
    const db = getDb()
    const src = seedThought({ id: 'slc-src', content: 'lifecycle-source', created_at: T_SRC })
    const tgt = seedThought({ id: 'slc-tgt', content: 'lifecycle-target', created_at: T_TGT })
    const plan: PlacementPlan = {
      thought_id: src,
      placement: null,
      edges: [],
      lifecycle: makeLifecycle('merge', { target_id: tgt, confidence: 0.9 }),
      degraded: false,
      generated_at: NOW,
    }
    const row = enqueuePlan(plan, { now: NOW }, db)[0]
    expect(isProposalStale(row, db)).toBe(false)
    seedEdge(src, tgt, 'supports')
    expect(isProposalStale(row, db)).toBe(true)
  })
})

// ── maxPendingProposals cap ───────────────────────────────────────────────────

describe('enqueuePlan: maxPendingProposals cap', () => {
  test('a new item beyond the live cap throws and the whole enqueue rolls back', () => {
    const db = getDb()
    const src = seedThought({ id: 'cap-src', content: 'cap source', created_at: T_SRC })
    const t1 = seedThought({ id: 'cap-t1', content: 'cap t1', created_at: T_TGT })
    const t2 = seedThought({ id: 'cap-t2', content: 'cap t2', created_at: T_TGT })
    const t3 = seedThought({ id: 'cap-t3', content: 'cap t3', created_at: T_TGT })
    const plan: PlacementPlan = {
      thought_id: src,
      placement: null,
      edges: [makeEdge(src, t1), makeEdge(src, t2, { type: 'contradicts' }), makeEdge(src, t3, { type: 'develops' })],
      lifecycle: makeLifecycle('keep'),
      degraded: false,
      generated_at: NOW,
    }
    withPlacementConfig({ maxPendingProposals: 2 }, () => {
      expect(() => enqueuePlan(plan, { now: NOW }, db)).toThrow(ValidationError)
      expect(() => enqueuePlan(plan, { now: NOW }, db)).toThrow(/maximum 2 pending placement proposals reached/)
      expect(queueRowCount(db)).toBe(0) // transaction rolled back
    })
  })

  test('refreshes of live rows do not count against the cap', () => {
    const db = getDb()
    const src = seedThought({ id: 'rcap-src', content: 'refresh-cap source', created_at: T_SRC })
    const t1 = seedThought({ id: 'rcap-t1', content: 'refresh-cap t1', created_at: T_TGT })
    const t2 = seedThought({ id: 'rcap-t2', content: 'refresh-cap t2', created_at: T_TGT })
    const t3 = seedThought({ id: 'rcap-t3', content: 'refresh-cap t3', created_at: T_TGT })
    const plan: PlacementPlan = {
      thought_id: src,
      placement: null,
      edges: [makeEdge(src, t1), makeEdge(src, t2, { type: 'contradicts' })],
      lifecycle: makeLifecycle('keep'),
      degraded: false,
      generated_at: NOW,
    }
    withPlacementConfig({ maxPendingProposals: 2 }, () => {
      const first = enqueuePlan(plan, { now: NOW }, db)
      const second = enqueuePlan(structuredClone(plan), { now: NOW_LATER }, db)
      expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id))
      // genuinely new third item still blocks
      const fresh = edgePlan(src, t3, { type: 'develops' })
      expect(() => enqueuePlan(fresh, { now: NOW_LATER }, db)).toThrow(/maximum 2 pending/)
      expect(queueRowCount(db)).toBe(2)
    })
  })

  test('rejecting a live row frees a slot for a new item', () => {
    const db = getDb()
    const src = seedThought({ id: 'fre-src', content: 'free slot source', created_at: T_SRC })
    const t1 = seedThought({ id: 'fre-t1', content: 'free slot t1', created_at: T_TGT })
    const t2 = seedThought({ id: 'fre-t2', content: 'free slot t2', created_at: T_TGT })
    const t3 = seedThought({ id: 'fre-t3', content: 'free slot t3', created_at: T_TGT })
    const plan: PlacementPlan = {
      thought_id: src,
      placement: null,
      edges: [makeEdge(src, t1), makeEdge(src, t2, { type: 'contradicts' })],
      lifecycle: makeLifecycle('keep'),
      degraded: false,
      generated_at: NOW,
    }
    withPlacementConfig({ maxPendingProposals: 2 }, () => {
      const rows = enqueuePlan(plan, { now: NOW }, db)
      reject(rows[0].id, { decidedBy: 'tester', now: NOW }, db)
      const third = enqueuePlan(edgePlan(src, t3, { type: 'develops' }), { now: NOW }, db)
      expect(third).toHaveLength(1)
      expect(list({ now: NOW }, db)).toHaveLength(2) // t2 + t3 live
    })
  })

  test('expired pending rows do not consume the cap', () => {
    const db = getDb()
    const src = seedThought({ id: 'exp-src', content: 'expiry-cap source', created_at: T_SRC })
    const t1 = seedThought({ id: 'exp-t1', content: 'expiry-cap t1', created_at: T_TGT })
    const t2 = seedThought({ id: 'exp-t2', content: 'expiry-cap t2', created_at: T_TGT })
    withPlacementConfig({ maxPendingProposals: 1 }, () => {
      enqueuePlan(edgePlan(src, t1), { now: '2026-01-01T00:00:00.000Z' }, db) // expires 2026-01-31 (TTL 30)
      const second = enqueuePlan(edgePlan(src, t2), { now: '2026-02-01T00:00:00.000Z' }, db)
      expect(second).toHaveLength(1) // first row is expired → not counted against the cap
      expect(list({ now: '2026-02-01T00:00:00.000Z' }, db)).toHaveLength(1)
    })
  })
})

// ── reject ────────────────────────────────────────────────────────────────────

describe('reject', () => {
  test('pending → rejected with audit metadata', () => {
    const db = getDb()
    const src = seedThought({ id: 'rj-src', content: 'reject source', created_at: T_SRC })
    const tgt = seedThought({ id: 'rj-tgt', content: 'reject target', created_at: T_TGT })
    const row = enqueuePlan(edgePlan(src, tgt), { now: NOW }, db)[0]
    const rejected = reject(row.id, { decidedBy: 'tester', now: NOW_LATER }, db)
    expect(rejected.state).toBe('rejected')
    expect(rejected.decided_by).toBe('tester')
    expect(rejected.decided_at).toBe(NOW_LATER)
    expect(list({ now: NOW_LATER }, db)).toHaveLength(0)
    expect(list({ state: 'rejected', now: NOW_LATER }, db)).toHaveLength(1)
  })

  test('rejecting a terminal row throws ValidationError', () => {
    const db = getDb()
    const src = seedThought({ id: 'rj2-src', content: 'reject-term source', created_at: T_SRC })
    const tgt = seedThought({ id: 'rj2-tgt', content: 'reject-term target', created_at: T_TGT })
    const row = enqueuePlan(edgePlan(src, tgt), { now: NOW }, db)[0]
    reject(row.id, { now: NOW }, db)
    expect(() => reject(row.id, { now: NOW_LATER }, db)).toThrow(ValidationError)
    expect(() => reject(row.id, { now: NOW_LATER }, db)).toThrow(/'rejected', not 'pending'/)
  })

  test('an unknown proposal id throws NotFoundError', () => {
    expect(() => reject('no-such-proposal', { now: NOW }, getDb())).toThrow(NotFoundError)
  })

  test('rejecting frees the dedup slot: re-enqueue creates a fresh pending row', () => {
    const db = getDb()
    const src = seedThought({ id: 'rj3-src', content: 'reject-free source', created_at: T_SRC })
    const tgt = seedThought({ id: 'rj3-tgt', content: 'reject-free target', created_at: T_TGT })
    const plan = edgePlan(src, tgt)
    const first = enqueuePlan(plan, { now: NOW }, db)[0]
    reject(first.id, { now: NOW_LATER }, db)
    const second = enqueuePlan(plan, { now: NOW_LATER }, db)
    expect(second).toHaveLength(1)
    expect(second[0].id).not.toBe(first.id)
    expect(second[0].state).toBe('pending')
    expect(queueRowCount(db)).toBe(2) // rejected + fresh pending
  })
})

// ── list ──────────────────────────────────────────────────────────────────────

describe('list', () => {
  test('defaults to live pending rows, newest first; terminal and expired rows are hidden', () => {
    const db = getDb()
    const s1 = seedThought({ id: 'ls-s1', content: 'live 1', created_at: T_SRC })
    const s2 = seedThought({ id: 'ls-s2', content: 'live 2', created_at: T_SRC })
    const s3 = seedThought({ id: 'ls-s3', content: 'live 3', created_at: T_SRC })
    const s4 = seedThought({ id: 'ls-s4', content: 'live 4', created_at: T_SRC })
    const s5 = seedThought({ id: 'ls-s5', content: 'live 5', created_at: T_SRC })
    const t1 = seedThought({ id: 'ls-t1', content: 't1', created_at: T_TGT })
    const t2 = seedThought({ id: 'ls-t2', content: 't2', created_at: T_TGT })
    const t3 = seedThought({ id: 'ls-t3', content: 't3', created_at: T_TGT })
    const t4 = seedThought({ id: 'ls-t4', content: 't4', created_at: T_TGT })
    const t5 = seedThought({ id: 'ls-t5', content: 't5', created_at: T_TGT })
    const a1 = enqueuePlan(edgePlan(s1, t1), { now: NOW }, db)[0]
    const a2 = enqueuePlan(edgePlan(s2, t2), { now: NOW }, db)[0]
    const a3 = enqueuePlan(edgePlan(s3, t3), { now: NOW }, db)[0]
    const a4 = enqueuePlan(edgePlan(s4, t4), { now: NOW }, db)[0]
    reject(a1.id, { now: NOW }, db)
    updateProposalState(db, a2.id, { state: 'accepted', decided_at: NOW })
    insertProposal(db, {
      source_thought_id: s5,
      item_kind: 'edge',
      target_id: t5,
      edge_type: 'supports',
      confidence: 0.5,
      rationale: 'pending but expired',
      payload: '{}',
      fingerprint: 'fp-old',
      expires_at: '2000-01-01T00:00:00.000Z',
    })
    // Force deterministic ordering by rewriting created_at for a3 / a4.
    db.prepare('UPDATE placement_proposals SET created_at = ? WHERE id = ?').run('2026-01-06T00:00:00.000Z', a4.id)
    db.prepare('UPDATE placement_proposals SET created_at = ? WHERE id = ?').run('2026-01-04T00:00:00.000Z', a3.id)
    expect(list({ now: NOW }, db).map((r) => r.id)).toEqual([a4.id, a3.id])
    expect(list({ state: 'rejected', now: NOW }, db).map((r) => r.id)).toEqual([a1.id])
    expect(list({ state: 'accepted', now: NOW }, db).map((r) => r.id)).toEqual([a2.id])
  })

  test('project filter and limit', () => {
    const db = getDb()
    const pa = seedThought({ id: 'lp-a', project_id: 'proj-a', content: 'project a', created_at: T_SRC })
    const pb = seedThought({ id: 'lp-b', project_id: 'proj-b', content: 'project b', created_at: T_SRC })
    const ta = seedThought({ id: 'lt-a', project_id: 'proj-a', content: 'ta', created_at: T_TGT })
    const tb = seedThought({ id: 'lt-b', project_id: 'proj-b', content: 'tb', created_at: T_TGT })
    const rowA = enqueuePlan(edgePlan(pa, ta), { now: NOW }, db)[0]
    enqueuePlan(edgePlan(pb, tb), { now: NOW }, db)
    expect(list({ projectId: 'proj-a', now: NOW }, db).map((r) => r.id)).toEqual([rowA.id])
    expect(list({ projectId: 'proj-b', now: NOW }, db)).toHaveLength(1)
    // limit
    for (let i = 0; i < 2; i++) {
      const s = seedThought({ id: `lp-x${i}`, project_id: 'proj-a', content: `extra ${i}`, created_at: T_SRC })
      const t = seedThought({ id: `lt-x${i}`, project_id: 'proj-a', content: `extra t ${i}`, created_at: T_TGT })
      enqueuePlan(edgePlan(s, t), { now: NOW }, db)
    }
    expect(list({ projectId: 'proj-a', limit: 2, now: NOW }, db)).toHaveLength(2)
  })

  test('pending rows past their TTL are hidden by the list clock; raising the clock back re-includes them', () => {
    const db = getDb()
    const src = seedThought({ id: 'lx-src', content: 'list-expire source', created_at: T_SRC })
    const tgt = seedThought({ id: 'lx-tgt', content: 'list-expire target', created_at: T_TGT })
    withPlacementConfig({ proposalTtlDays: 1 }, () => {
      const rows = enqueuePlan(edgePlan(src, tgt), { now: '2026-01-01T00:00:00.000Z' }, db)
      expect(rows[0].expires_at).toBe('2026-01-02T00:00:00.000Z')
      expect(list({ now: '2026-01-01T12:00:00.000Z' }, db)).toHaveLength(1)
      expect(list({ now: '2026-01-03T00:00:00.000Z' }, db)).toHaveLength(0)
    })
  })
})

// ── draft guard ───────────────────────────────────────────────────────────────

describe('enqueuePlan: draft guard', () => {
  test('the draft sentinel id cannot be enqueued', () => {
    expect(() => enqueuePlan(edgePlan(DRAFT_THOUGHT_ID, 'dg-tgt'), { now: NOW }, getDb())).toThrow(ValidationError)
    expect(() => enqueuePlan(edgePlan(DRAFT_THOUGHT_ID, 'dg-tgt'), { now: NOW }, getDb())).toThrow(/draft or unknown thought/)
  })

  test('an unknown thought id cannot be enqueued', () => {
    expect(() => enqueuePlan(edgePlan('unknown-thought-id', 'dg-x'), { now: NOW }, getDb())).toThrow(ValidationError)
  })
})

// ── determinism ───────────────────────────────────────────────────────────────

describe('determinism', () => {
  test('re-enqueueing the same plan refreshes identical rows (same ids, no duplicates)', () => {
    const db = getDb()
    const src = seedThought({ id: 'det-src', content: 'determinism subject', created_at: T_SRC })
    const t1 = seedThought({ id: 'det-t1', content: 'determinism first', created_at: T_TGT })
    const t2 = seedThought({ id: 'det-t2', content: 'determinism second', created_at: T_TGT })
    const cl = seedThought({ id: 'det-cl', content: 'cluster', is_cluster: 1, created_at: T_TGT })
    const plan: PlacementPlan = {
      thought_id: src,
      placement: makePlacement(cl, 'cluster'),
      edges: [makeEdge(src, t1), makeEdge(src, t2, { type: 'contradicts', direction: 'directed' })],
      lifecycle: makeLifecycle('link'),
      degraded: false,
      generated_at: NOW,
    }
    const first = enqueuePlan(plan, { now: NOW }, db)
    const second = enqueuePlan(structuredClone(plan), { now: NOW_LATER }, db)
    expect(second.length).toBe(first.length)
    for (let i = 0; i < first.length; i++) {
      expect(second[i].id).toBe(first[i].id)
      expect(second[i].created_at).toBe(first[i].created_at)
      expect(second[i].fingerprint).toBe(first[i].fingerprint)
      expect(second[i].payload).toBe(first[i].payload)
    }
    expect(list({ now: NOW_LATER }, db)).toHaveLength(first.length)
  })

  test('same plan + same snapshot ⇒ same rows across two fresh databases', () => {
    const runOnce = (): string[] => {
      createTestDb()
      seedThought({ id: 'fd-src', content: 'fresh db subject', created_at: T_SRC })
      const t1 = seedThought({ id: 'fd-t1', content: 'fresh db first', created_at: T_TGT })
      const t2 = seedThought({ id: 'fd-t2', content: 'fresh db second', created_at: T_TGT })
      const plan: PlacementPlan = {
        thought_id: 'fd-src',
        placement: null,
        edges: [makeEdge('fd-src', t1), makeEdge('fd-src', t2, { type: 'contradicts' })],
        lifecycle: makeLifecycle('keep'),
        degraded: false,
        generated_at: NOW,
      }
      return enqueuePlan(plan, { now: NOW }, getDb())
        .map((r) =>
          [r.source_thought_id, r.item_kind, r.target_id, r.edge_type, r.lifecycle_action, r.direction, r.confidence, r.rationale, r.rule_id, r.payload, r.fingerprint, r.expires_at].join('|')
        )
        .sort()
    }
    const first = runOnce()
    const second = runOnce()
    expect(first).toEqual(second)
    expect(first).toHaveLength(2)
  })
})

// ── regression: proposePlacementPlan leaves the queue untouched ──────────────

describe('regression: proposePlacementPlan does not write to placement_proposals', () => {
  test('existing-thought propose writes no row; enqueuing the same plan does', async () => {
    const db = getDb()
    const src = seedThought({ id: 'reg-src', content: 'regression source alpha', created_at: T_SRC })
    const tgt = seedThought({ id: 'reg-tgt', content: 'regression target beta', created_at: T_TGT })
    const plan = await proposePlacementPlan(
      { thoughtId: src },
      { now: NOW },
      { embed: okEmbed, searchNeighbors: () => [{ id: tgt, similarity: 0.9 }] },
      db,
    )
    expect(plan.edges.length).toBeGreaterThanOrEqual(1)
    expect(queueRowCount(db)).toBe(0)
    // Only explicit enqueuePlan writes the queue.
    const rows = enqueuePlan(plan, { now: NOW }, db)
    expect(rows.length).toBeGreaterThanOrEqual(1)
  })

  test('draft-content propose also leaves the queue empty', async () => {
    const db = getDb()
    const tgt = seedThought({ id: 'reg-draft-tgt', content: 'the quick brown fox jumped', created_at: T_TGT })
    const plan = await proposePlacementPlan(
      { content: 'the quick brown fox', projectId: 'default' },
      { now: NOW },
      { embed: okEmbed, searchNeighbors: () => [{ id: tgt, similarity: 0.9 }] },
      db,
    )
    expect(plan.thought_id).toBe(DRAFT_THOUGHT_ID)
    expect(queueRowCount(db)).toBe(0)
  })
})
