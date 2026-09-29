import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { config, DEFAULTS, ENV_MAPPINGS } from '../config'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb, getDb } from '../db'
import { buildConfigDisplay } from './config-display.service'
import {
  cleanupPlacementProposals,
  startPlacementRetentionJob,
  stopPlacementRetentionJob
} from './placement-retention.service'
import {
  insertProposal,
  updateProposalState,
  listProposals,
  type InsertProposalInput
} from '../db/placement-proposals'

beforeEach(createTestDb)
afterEach(closeDb)

// ── helpers ──────────────────────────────────────────────────────────────────

function makeInput(overrides?: Partial<InsertProposalInput>): InsertProposalInput {
  return {
    source_thought_id: overrides?.source_thought_id ?? seedThought(),
    item_kind: overrides?.item_kind ?? 'edge',
    confidence: overrides?.confidence ?? 0.8,
    rationale: overrides?.rationale ?? 'test rationale',
    payload: overrides?.payload ?? JSON.stringify({ foo: 'bar' }),
    fingerprint: overrides?.fingerprint ?? 'fp-1',
    ...overrides
  }
}

/**
 * Deterministic clock injection: patch global Date for the duration of `fn`.
 * Restores the original on exit (including when fn throws).
 */
function withClock(nowMs: number, fn: () => void): void {
  const OrigDate = globalThis.Date
  Object.assign(globalThis, { Date: class extends OrigDate { static now() { return nowMs } } })
  try {
    fn()
  } finally {
    Object.assign(globalThis, { Date: OrigDate })
  }
}

/** Run `bun -e script` in a subprocess with optional env overrides. */
async function runInSubprocess(script: string, env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawnSync(
    [process.execPath, '-e', script],
    { env: { ...process.env, ...env }, cwd: join(import.meta.dir, '..', '..') }
  )
  return proc.stdout.toString().trim()
}

const CONFIG_PROBE = `
import { config } from './src/config';
console.log(config.placement.proposalTtlDays + ',' + config.placement.maxPendingProposals);
`

// ── config defaults ───────────────────────────────────────────────────────────

describe('config defaults', () => {
  test('placement.proposalTtlDays defaults to 30', () => {
    expect(DEFAULTS.placement.proposalTtlDays).toBe(30)
    expect(config.placement.proposalTtlDays).toBe(30)
  })

  test('placement.maxPendingProposals defaults to 500', () => {
    expect(DEFAULTS.placement.maxPendingProposals).toBe(500)
    expect(config.placement.maxPendingProposals).toBe(500)
  })

  test('placement.maxClusterSize defaults to 50', () => {
    expect(DEFAULTS.placement.maxClusterSize).toBe(50)
  })
})

// ── env overrides (subprocess) ──────────────────────────────────────────────
// config is built at module-load time from process.env; a fresh subprocess is
// the only way to verify that env vars actually change the resolved value.

describe('env overrides', () => {
  test('SYNAPTOMIND_PLACEMENT_PROPOSAL_TTL_DAYS overrides the default', async () => {
    const out = await runInSubprocess(CONFIG_PROBE, {
      SYNAPTOMIND_PLACEMENT_PROPOSAL_TTL_DAYS: '7'
    })
    expect(out).toBe('7,500')
  })

  test('SYNAPTOMIND_PLACEMENT_MAX_PENDING_PROPOSALS overrides the default', async () => {
    const out = await runInSubprocess(CONFIG_PROBE, {
      SYNAPTOMIND_PLACEMENT_MAX_PENDING_PROPOSALS: '100'
    })
    expect(out).toBe('30,100')
  })

  test('both env overrides compose', async () => {
    const out = await runInSubprocess(CONFIG_PROBE, {
      SYNAPTOMIND_PLACEMENT_PROPOSAL_TTL_DAYS: '14',
      SYNAPTOMIND_PLACEMENT_MAX_PENDING_PROPOSALS: '200'
    })
    expect(out).toBe('14,200')
  })

  test('env var absent falls back to defaults', async () => {
    const out = await runInSubprocess(CONFIG_PROBE)
    expect(out).toBe('30,500')
  })

  test('ENV_MAPPINGS has the right env-name→path pairs', () => {
    const ttlMapping = ENV_MAPPINGS.find(m => m.path === 'placement.proposalTtlDays')
    expect(ttlMapping?.env).toBe('SYNAPTOMIND_PLACEMENT_PROPOSAL_TTL_DAYS')
    expect(ttlMapping?.type).toBe('int')

    const maxMapping = ENV_MAPPINGS.find(m => m.path === 'placement.maxPendingProposals')
    expect(maxMapping?.env).toBe('SYNAPTOMIND_PLACEMENT_MAX_PENDING_PROPOSALS')
    expect(maxMapping?.type).toBe('int')
  })
})

// ── buildConfigDisplay inclusion ──────────────────────────────────────────────

describe('buildConfigDisplay placement section', () => {
  test('includes the Placement section header', () => {
    const out = buildConfigDisplay()
    expect(out).toContain('--- Placement ---')
  })

  test('includes placement.proposalTtlDays with default value and env mapping', () => {
    const out = buildConfigDisplay()
    const line = out.split('\n').find(l => l.includes('placement.proposalTtlDays'))
    expect(line).toBeDefined()
    expect(line).toContain('30')
    expect(line).toContain('SYNAPTOMIND_PLACEMENT_PROPOSAL_TTL_DAYS')
  })

  test('includes placement.maxPendingProposals with default value and env mapping', () => {
    const out = buildConfigDisplay()
    const line = out.split('\n').find(l => l.includes('placement.maxPendingProposals'))
    expect(line).toBeDefined()
    expect(line).toContain('500')
    expect(line).toContain('SYNAPTOMIND_PLACEMENT_MAX_PENDING_PROPOSALS')
  })

  test('includes placement.maxClusterSize', () => {
    const out = buildConfigDisplay()
    const line = out.split('\n').find(l => l.includes('placement.maxClusterSize'))
    expect(line).toBeDefined()
    expect(line).toContain('50')
  })

  test('annotates when an override differs from the default', () => {
    const saved = { ...config.placement }
    config.placement = { ...saved, proposalTtlDays: 14 }
    try {
      const out = buildConfigDisplay()
      const line = out.split('\n').find(l => l.includes('placement.proposalTtlDays'))
      expect(line).toContain('14')
      expect(line).toContain('[default: 30]')
    } finally {
      config.placement = saved
    }
  })
})

// ── cleanupPlacementProposals with injected clock ─────────────────────────────

describe('cleanupPlacementProposals', () => {
  // Keep a stable reference to the saved placement config so we can restore it.
  const savedPlacement = { ...config.placement }

  afterEach(() => {
    config.placement = savedPlacement
  })

  test('pending past expires_at → expired', () => {
    config.placement = { ...config.placement, proposalTtlDays: 30 }
    withClock(Date.now(), () => {
      const db = getDb()
      const src = seedThought()
      insertProposal(db, makeInput({
        source_thought_id: src,
        expires_at: new Date(Date.now() - 10 * 86400000).toISOString(),
        item_kind: 'edge',
        edge_type: 'develops'
      }))
      const removed = cleanupPlacementProposals(db)
      expect(removed).toBe(1)
      // No longer pending
      expect(listProposals(db)).toHaveLength(0)
      // Row still exists in state=expired
      const expiredRows = db.prepare("SELECT id FROM placement_proposals WHERE state = 'expired'").all() as { id: string }[]
      expect(expiredRows).toHaveLength(1)
    })
  })

  test('terminal older than TTL → pruned (deleted)', () => {
    config.placement = { ...config.placement, proposalTtlDays: 30 }
    withClock(Date.now(), () => {
      const db = getDb()
      const src = seedThought()
      const accepted = insertProposal(db, makeInput({ source_thought_id: src, item_kind: 'placement' }))
      updateProposalState(db, accepted.id, {
        state: 'accepted',
        decided_at: new Date(Date.now() - 60 * 86400000).toISOString()
      })
      const removed = cleanupPlacementProposals(db)
      expect(removed).toBe(1)
      // Row physically deleted
      const remaining = db.prepare("SELECT id FROM placement_proposals").all() as { id: string }[]
      expect(remaining).toHaveLength(0)
    })
  })

  test('fresh rows are untouched', () => {
    config.placement = { ...config.placement, proposalTtlDays: 30 }
    withClock(Date.now(), () => {
      const db = getDb()
      const src1 = seedThought()
      const src2 = seedThought()
      // Pending with expires_at 10 days in the future — should stay pending.
      insertProposal(db, makeInput({
        source_thought_id: src1,
        expires_at: new Date(Date.now() + 10 * 86400000).toISOString(),
        item_kind: 'edge',
        edge_type: 'parent'
      }))
      // Terminal row decided 1 day ago — should stay in the table.
      const accepted = insertProposal(db, makeInput({ source_thought_id: src2, item_kind: 'placement' }))
      updateProposalState(db, accepted.id, {
        state: 'accepted',
        decided_at: new Date(Date.now() - 1 * 86400000).toISOString()
      })
      const removed = cleanupPlacementProposals(db)
      expect(removed).toBe(0)
      // Both rows still exist
      const all = db.prepare('SELECT id, state FROM placement_proposals ORDER BY id').all() as Array<{ id: string; state: string }>
      expect(all).toHaveLength(2)
      const states = all.map(r => r.state).sort()
      expect(states).toEqual(['accepted', 'pending'])
    })
  })

  test('ttlDays < 0 is a no-op', () => {
    config.placement = { ...config.placement, proposalTtlDays: -1 }
    withClock(Date.now(), () => {
      const db = getDb()
      const src = seedThought()
      insertProposal(db, makeInput({
        source_thought_id: src,
        expires_at: new Date(Date.now() - 100 * 86400000).toISOString(),
        item_kind: 'edge',
        edge_type: 'related'
      }))
      const removed = cleanupPlacementProposals(db)
      expect(removed).toBe(0)
      // Row still pending despite being stale.
      expect(listProposals(db)).toHaveLength(1)
    })
  })

  test('mixed old and fresh rows: only the stale ones are affected', () => {
    config.placement = { ...config.placement, proposalTtlDays: 30 }
    withClock(Date.now(), () => {
      const db = getDb()
      const srcExpire = seedThought()
      const srcPrune = seedThought()
      const srcFresh = seedThought()

      // Pending → expires in the past.
      insertProposal(db, makeInput({
        source_thought_id: srcExpire,
        expires_at: new Date(Date.now() - 10 * 86400000).toISOString(),
        item_kind: 'edge',
        edge_type: 'develops'
      }))
      // Terminal → accepted 60 days ago.
      const accepted = insertProposal(db, makeInput({ source_thought_id: srcPrune, item_kind: 'placement' }))
      updateProposalState(db, accepted.id, {
        state: 'accepted',
        decided_at: new Date(Date.now() - 60 * 86400000).toISOString()
      })
      // Fresh: pending with no expires_at (survives).
      insertProposal(db, makeInput({ source_thought_id: srcFresh, item_kind: 'lifecycle' }))

      const removed = cleanupPlacementProposals(db)
      expect(removed).toBe(2)
      // Only the fresh one remains, and it is still pending.
      expect(listProposals(db)).toHaveLength(1)
      const freshRow = db.prepare("SELECT state FROM placement_proposals WHERE state = 'pending'").all() as { state: string }[]
      expect(freshRow).toHaveLength(1)
    })
  })

  test('pending with expires_at = null survives the TTL run', () => {
    config.placement = { ...config.placement, proposalTtlDays: 30 }
    withClock(Date.now(), () => {
      const db = getDb()
      const src = seedThought()
      insertProposal(db, makeInput({ source_thought_id: src, expires_at: null }))
      const removed = cleanupPlacementProposals(db)
      expect(removed).toBe(0)
      expect(listProposals(db)).toHaveLength(1)
    })
  })
})

// ── start/stop idempotency ────────────────────────────────────────────────────

describe('start/stop idempotency', () => {
  test('calling startPlacementRetentionJob multiple times does not throw', () => {
    startPlacementRetentionJob()
    expect(() => startPlacementRetentionJob()).not.toThrow()
    stopPlacementRetentionJob()
  })

  test('calling stopPlacementRetentionJob multiple times does not throw', () => {
    stopPlacementRetentionJob()
    expect(() => stopPlacementRetentionJob()).not.toThrow()
  })

  test('start then stop is a no-op on repeated calls', () => {
    startPlacementRetentionJob()
    stopPlacementRetentionJob()
    expect(() => stopPlacementRetentionJob()).not.toThrow()
    expect(() => startPlacementRetentionJob()).not.toThrow()
    stopPlacementRetentionJob()
  })
})
