import { beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { closeDb, getDb } from '../../db'
import { createTestDb, seedThought } from '../../test/helpers'
import { proposePlacementPlan } from './engine'
import { decideLifecycle } from './lifecycle'
import type { EdgeProposal, LifecycleAction, PairSignals } from './types'

beforeEach(createTestDb)
afterEach(closeDb)

const NOW = '2026-01-01T00:00:00.000Z'
const T0 = '2025-01-01T00:00:00.000Z'
const T1 = '2025-02-01T00:00:00.000Z'

function okEmbed(): (texts: string[]) => Promise<Float32Array[]> {
  return async texts => texts.map(() => new Float32Array(384))
}

function stubSearch(map: Record<string, Array<{ id: string; similarity: number }>>) {
  return (_id: string, _emb: Float32Array, _topK: number) => map[_id] ?? []
}

function makeReplaceEdge(sourceId: string, targetId: string, targetStatus: string): EdgeProposal {
  return {
    source_id: sourceId,
    target_id: targetId,
    type: 'replaces',
    direction: 'directed',
    confidence: 0.85,
    rationale:
      'source is newer, near-duplicate and carries an evolution cue; propose replaces (+ archive)',
    review_required: true,
    rule_id: 'supersede.newer_replaces_older',
    signals: {
      sourceId,
      targetId,
      embeddingSimilarity: 0.9,
      lexicalOverlap: 0.83,
      negationDelta: 0,
      evidentialCue: false,
      evolutionCue: true,
      temporalOrder: 'newer',
      tagOverlap: 0,
      dependencyCue: false,
      existingEdgeType: null,
      sourceStatus: 'active',
      targetStatus,
      sourceStanding: 'current',
      targetStanding: 'current',
      sameProject: true
    } as PairSignals
  }
}

describe('decideLifecycle — replaces+archive endpoint matrix', () => {
  const table = [
    {
      targetStatus: 'active',
      sourceStatus: 'active',
      expectedAction: 'replaces+archive' as LifecycleAction,
      expectedBlocked: [] as string[],
      expectReplace: true
    },
    {
      targetStatus: 'active',
      sourceStatus: 'archived',
      expectedAction: 'replaces+archive' as LifecycleAction,
      expectedBlocked: [] as string[],
      expectReplace: true
    },
    {
      targetStatus: 'archived',
      sourceStatus: 'active',
      expectedAction: 'replaces+archive' as LifecycleAction,
      expectedBlocked: ['target is archived'],
      expectReplace: true
    },
    {
      targetStatus: 'archived',
      sourceStatus: 'archived',
      expectedAction: 'replaces+archive' as LifecycleAction,
      expectedBlocked: ['target is archived'],
      expectReplace: true
    }
  ]

  test.each(table)(
    'target=%s source=%s → action=%s blocked=%j',
    ({ targetStatus, sourceStatus, expectedAction, expectedBlocked }) => {
      const sourceId = 'dl-src'
      const targetId = 'dl-tgt'
      const replaceEdge = makeReplaceEdge(sourceId, targetId, targetStatus)

      const result = decideLifecycle(
        {
          id: sourceId,
          content: 'now postgres for storage persists data',
          created_at: T1,
          status: sourceStatus,
          project_id: 'default',
          tags: [],
          source: null,
          is_cluster: 0,
          is_protected: 1,
          is_global: 0,
          updated_at: T1,
          archived_at: null,
          surface_after: null
        },
        replaceEdge,
        [],
        undefined,
        false
      )

      expect(result.action).toBe(expectedAction)
      expect(result.blocked_by).toEqual(expectedBlocked)
    }
  )
})

describe('replaces+archive direction vs merge precedent', () => {
  test('edge source_id = newer survivor, target_id = older superseded', async () => {
    const db = getDb()
    const olderId = seedThought({
      id: 'dir-old',
      content: 'postgres for storage persists data',
      created_at: T0
    })
    const newerId = seedThought({
      id: 'dir-new',
      content: 'postgres now for storage persists data',
      created_at: T1
    })

    const p = await proposePlacementPlan(
      { thoughtId: newerId },
      { now: NOW },
      {
        embed: okEmbed(),
        searchNeighbors: stubSearch({ [newerId]: [{ id: olderId, similarity: 0.9 }] })
      },
      db
    )

    expect(p.lifecycle.action).toBe('replaces+archive')
    expect(p.edges).toHaveLength(1)
    const edge = p.edges[0]

    expect(edge.source_id).toBe(newerId)
    expect(edge.target_id).toBe(olderId)
    expect(edge.signals.temporalOrder).toBe('newer')
    expect(edge.signals.targetStatus).toBe('active')

    expect(p.lifecycle.rationale).toContain('archive the older target')
    expect(p.lifecycle.rationale).toContain(olderId)
    expect(p.lifecycle.rationale).not.toContain(newerId)
  })

  test('merge creates the same edge direction: survivor(targetId) → archived(sourceId)', async () => {
    const db = getDb()
    const olderId = seedThought({
      id: 'mp-old',
      content: 'postgres for storage persists data',
      created_at: T0
    })
    const newerId = seedThought({
      id: 'mp-new',
      content: 'postgres now for storage persists data',
      created_at: T1
    })

    const p = await proposePlacementPlan(
      { thoughtId: newerId },
      { now: NOW },
      {
        embed: okEmbed(),
        searchNeighbors: stubSearch({ [newerId]: [{ id: olderId, similarity: 0.9 }] })
      },
      db
    )

    expect(p.lifecycle.action).toBe('replaces+archive')
    expect(p.edges[0].source_id).toBe(newerId)
    expect(p.edges[0].target_id).toBe(olderId)
  })

  test('getReplacedTargetIds returns edge targets — the older/superseded ones', async () => {
    const db = getDb()
    const olderId = seedThought({
      id: 'grt-old',
      content: 'postgres for storage persists data',
      created_at: T0
    })
    const newerId = seedThought({
      id: 'grt-new',
      content: 'postgres now for storage persists data',
      created_at: T1
    })

    const p = await proposePlacementPlan(
      { thoughtId: newerId },
      { now: NOW },
      {
        embed: okEmbed(),
        searchNeighbors: stubSearch({ [newerId]: [{ id: olderId, similarity: 0.9 }] })
      },
      db
    )

    expect(p.edges[0].target_id).toBe(olderId)
  })
})

describe('proposePlacementPlan — archived target drops supersede edge', async () => {
  test('archived target: supersede edge is gated out, lifecycle falls through', async () => {
    const db = getDb()
    const olderId = seedThought({
      id: 'eng-old',
      content: 'postgres for storage persists data',
      created_at: T0,
      status: 'archived'
    })
    const newerId = seedThought({
      id: 'eng-new',
      content: 'postgres now for storage persists data',
      created_at: T1
    })

    const p = await proposePlacementPlan(
      { thoughtId: newerId },
      { now: NOW },
      {
        embed: okEmbed(),
        searchNeighbors: stubSearch({ [newerId]: [{ id: olderId, similarity: 0.9 }] })
      },
      db
    )

    expect(p.lifecycle.action).not.toBe('replaces+archive')
    expect(p.edges.every(e => e.rule_id !== 'supersede.newer_replaces_older')).toBe(true)
  })

  test('active target + archived source: replaces+archive fires, no blocker', async () => {
    const db = getDb()
    const olderId = seedThought({ id: 'as-old', content: 'x y z', created_at: T0 })
    const newerId = seedThought({
      id: 'as-new',
      content: 'x y z updated w',
      created_at: T1,
      status: 'archived'
    })

    const p = await proposePlacementPlan(
      { thoughtId: newerId },
      { now: NOW },
      {
        embed: okEmbed(),
        searchNeighbors: stubSearch({ [newerId]: [{ id: olderId, similarity: 0.9 }] })
      },
      db
    )

    expect(p.lifecycle.action).toBe('replaces+archive')
    expect(p.lifecycle.blocked_by).toEqual([])
    expect(p.edges[0].source_id).toBe(newerId)
    expect(p.edges[0].target_id).toBe(olderId)
  })
})
