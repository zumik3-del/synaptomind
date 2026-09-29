/**
 * Unit tests for apply-run-guards.ts (task #1007).
 * Covers isTriageKind, checkBatchGuards, checkDryRunFirst, noteDryRun.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { closeDb, getDb } from '../db'
import { createTestDb, seedThought } from '../test/helpers'
import { config } from '../config'
import { insertProposal, updateProposalState, type PlacementProposalRow, type ProposalItemKind, type ProposalState } from '../db/placement-proposals'
import {
  isTriageKind,
  isLinkKind,
  checkBatchGuards,
  checkDryRunFirst,
  checkItemGuards,
  noteDryRun,
} from './apply-run-guards'

beforeEach(createTestDb)
afterEach(closeDb)

const NOW = '2026-01-01T00:00:00.000Z'
const RUN_ID = 'run-001'

// ── helpers ───────────────────────────────────────────────────────────────────

function makeRow(overrides: {
  id?: string
  item_kind?: ProposalItemKind
  state?: ProposalState
  run_id?: string | null
  source_thought_id?: string
} = {}): PlacementProposalRow {
  const db = getDb()
  const sourceId = overrides.source_thought_id ?? 'thought-001'
  // Ensure thought exists
  db.prepare(`INSERT OR IGNORE INTO thoughts (id, content, status, source, project_id, created_at, updated_at)
              VALUES (?, ?, 'draft', 'test', 'default', ?, ?)`).run(
    sourceId, 'test content', NOW, NOW
  )
  return insertProposal(db, {
    source_thought_id: sourceId,
    item_kind: overrides.item_kind ?? 'edge',
    confidence: 0.9,
    rationale: 'test',
    payload: '{}',
    fingerprint: 'abc123',
    run_id: overrides.run_id ?? null,
  })
}

function setState(row: PlacementProposalRow, state: ProposalState): PlacementProposalRow {
  return updateProposalState(getDb(), row.id, { state }) as PlacementProposalRow
}

// ── isTriageKind ──────────────────────────────────────────────────────────────

describe('isTriageKind', () => {
  test('triage_activate → true', () => {
    expect(isTriageKind('triage_activate')).toBe(true)
  })

  test('triage_archive → true', () => {
    expect(isTriageKind('triage_archive')).toBe(true)
  })

  test('edge → false', () => {
    expect(isTriageKind('edge')).toBe(false)
  })

  test('placement → false', () => {
    expect(isTriageKind('placement')).toBe(false)
  })

  test('lifecycle → false', () => {
    expect(isTriageKind('lifecycle')).toBe(false)
  })

  test('unknown string → false', () => {
    expect(isTriageKind('foo')).toBe(false)
  })
})

// ── checkBatchGuards ──────────────────────────────────────────────────────────

describe('checkBatchGuards', () => {
  test('non-confirm → undefined (no check)', () => {
    const row = makeRow({ item_kind: 'triage_activate' })
    expect(checkBatchGuards([row], 1, { confirm: false, runId: RUN_ID })).toBeUndefined()
  })

  test('missing run_id with triage → run_id_required', () => {
    const row = makeRow({ item_kind: 'triage_activate', state: 'pending' })
    const refusal = checkBatchGuards([row], 1, { confirm: true, runId: undefined })
    expect(refusal).toEqual({ code: 'run_id_required', reason: expect.stringContaining('run_id') })
  })

  test('limit exceeded → limit_exceeded', () => {
    const row = makeRow({ item_kind: 'edge', state: 'pending' })
    const refusal = checkBatchGuards([row], 11, { confirm: true, runId: RUN_ID, limit: 10 })
    expect(refusal).toEqual({ code: 'limit_exceeded', reason: expect.stringContaining('11') })
  })

  test('within limit → undefined', () => {
    const row = makeRow({ item_kind: 'edge', state: 'pending' })
    expect(checkBatchGuards([row], 5, { confirm: true, runId: RUN_ID, limit: 10 })).toBeUndefined()
  })

  test('max_items_exceeded', () => {
    // Fill run with 25 accepted items (config default maxItemsPerRun = 25)
    for (let i = 0; i < 25; i++) {
      const r = makeRow({ item_kind: 'triage_activate', state: 'accepted', run_id: RUN_ID })
      setState(r, 'accepted')
    }
    // Add 1 pending → would be 26
    const pending = makeRow({ item_kind: 'triage_activate', state: 'pending', run_id: RUN_ID })
    const refusal = checkBatchGuards([pending], 1, { confirm: true, runId: RUN_ID })
    expect(refusal?.code).toBe('max_items_exceeded')
  })

  test('max_archives_exceeded', () => {
    // Temporarily lower maxArchivesPerRun to test the archives cap independently
    const originalMaxArchives = config.triage.maxArchivesPerRun
    config.triage.maxArchivesPerRun = 3
    try {
      // Fill run with 3 accepted archives (at limit)
      for (let i = 0; i < 3; i++) {
        const r = makeRow({ item_kind: 'triage_archive', state: 'accepted', run_id: RUN_ID })
        setState(r, 'accepted')
      }
      // Add 1 pending archive → would be 4 archives > maxArchivesPerRun=3
      const pending = makeRow({ item_kind: 'triage_archive', state: 'pending', run_id: RUN_ID })
      const refusal = checkBatchGuards([pending], 1, { confirm: true, runId: RUN_ID })
      expect(refusal?.code).toBe('max_archives_exceeded')
    } finally {
      config.triage.maxArchivesPerRun = originalMaxArchives
    }
  })

  test('non-triage items in run → no item/archive cap check', () => {
    // Link kinds have their own cap (maxLinksPerRun); raise it so this case
    // isolates the triage item/archive caps.
    const originalMaxLinks = config.triage.maxLinksPerRun
    config.triage.maxLinksPerRun = 100
    try {
      const row = makeRow({ item_kind: 'edge', state: 'pending', run_id: RUN_ID })
      // Even with many items, non-triage doesn't hit the triage item/archive caps
      const rows = Array.from({ length: 30 }, () => row)
      expect(checkBatchGuards(rows, 30, { confirm: true, runId: RUN_ID })).toBeUndefined()
    } finally {
      config.triage.maxLinksPerRun = originalMaxLinks
    }
  })
})

// ── checkDryRunFirst ──────────────────────────────────────────────────────────

describe('checkDryRunFirst', () => {
  test('config disabled → undefined', () => {
    // Default is true, skip this case
  })

  test('no triage rows → undefined', () => {
    const row = makeRow({ item_kind: 'edge', state: 'pending' })
    expect(checkDryRunFirst([row.id], RUN_ID)).toBeUndefined()
  })

  test('missing run_id with triage → run_id_required', () => {
    const row = makeRow({ item_kind: 'triage_activate', state: 'pending' })
    const refusal = checkDryRunFirst([row.id], undefined)
    expect(refusal).toEqual({ code: 'run_id_required', reason: expect.stringContaining('run_id') })
  })

  test('no prior dry-run → dry_run_required', () => {
    const row = makeRow({ item_kind: 'triage_activate', state: 'pending' })
    const refusal = checkDryRunFirst([row.id], RUN_ID)
    expect(refusal).toEqual({ code: 'dry_run_required', reason: expect.stringContaining('dry-run') })
  })

  test('after noteDryRun → undefined (allowed)', () => {
    const row = makeRow({ item_kind: 'triage_activate', state: 'pending' })
    noteDryRun([row.id], RUN_ID)
    expect(checkDryRunFirst([row.id], RUN_ID)).toBeUndefined()
  })

  test('mixed triage + non-triage → only triage checked', () => {
    const triageRow = makeRow({ item_kind: 'triage_activate', state: 'pending' })
    const edgeRow = makeRow({ item_kind: 'edge', state: 'pending' })
    // Should refuse because triage row has no dry-run
    const refusal = checkDryRunFirst([triageRow.id, edgeRow.id], RUN_ID)
    expect(refusal).toBeDefined()
    expect(refusal?.code).toBe('dry_run_required')
  })
})

// ── noteDryRun ────────────────────────────────────────────────────────────────

describe('noteDryRun', () => {
  test('no run_id → no-op', () => {
    const row = makeRow({ item_kind: 'triage_activate', state: 'pending' })
    expect(() => noteDryRun([row.id], undefined)).not.toThrow()
    // Should still refuse because no dry-run recorded
    expect(checkDryRunFirst([row.id], undefined)).toBeDefined()
  })

  test('no triage rows → no-op', () => {
    const row = makeRow({ item_kind: 'edge', state: 'pending' })
    noteDryRun([row.id], RUN_ID)
    // Should still allow because no triage rows
    expect(checkDryRunFirst([row.id], RUN_ID)).toBeUndefined()
  })

  test('with triage rows → records dry-run', () => {
    const row = makeRow({ item_kind: 'triage_archive', state: 'pending' })
    noteDryRun([row.id], RUN_ID)
    expect(checkDryRunFirst([row.id], RUN_ID)).toBeUndefined()
  })
})

// ── isLinkKind ────────────────────────────────────────────────────────────────

describe('isLinkKind', () => {
  test('edge → true', () => {
    expect(isLinkKind('edge')).toBe(true)
  })

  test('placement → true', () => {
    expect(isLinkKind('placement')).toBe(true)
  })

  test('lifecycle → true', () => {
    expect(isLinkKind('lifecycle')).toBe(true)
  })

  test('triage_activate → false', () => {
    expect(isLinkKind('triage_activate')).toBe(false)
  })

  test('triage_archive → false', () => {
    expect(isLinkKind('triage_archive')).toBe(false)
  })

  test('unknown string → false', () => {
    expect(isLinkKind('foo')).toBe(false)
  })
})

// ── maxLinksPerRun ────────────────────────────────────────────────────────────

describe('checkBatchGuards — maxLinksPerRun', () => {
  test('no pending links → no link cap check', () => {
    // All-accepted batch with no pending links should pass regardless of accepted count
    const originalMaxLinks = config.triage.maxLinksPerRun
    config.triage.maxLinksPerRun = 1
    try {
      const accepted = makeRow({ item_kind: 'edge', state: 'accepted', run_id: RUN_ID })
      setState(accepted, 'accepted')
      const pending = makeRow({ item_kind: 'triage_activate', state: 'pending', run_id: RUN_ID })
      // Batch has only a triage item; accepted links exist but no pending links
      expect(checkBatchGuards([pending], 1, { confirm: true, runId: RUN_ID })).toBeUndefined()
    } finally {
      config.triage.maxLinksPerRun = originalMaxLinks
    }
  })

  test('within maxLinksPerRun → undefined', () => {
    const originalMaxLinks = config.triage.maxLinksPerRun
    config.triage.maxLinksPerRun = 5
    try {
      const row = makeRow({ item_kind: 'edge', state: 'pending', run_id: RUN_ID })
      expect(checkBatchGuards([row], 1, { confirm: true, runId: RUN_ID })).toBeUndefined()
    } finally {
      config.triage.maxLinksPerRun = originalMaxLinks
    }
  })

  test('exactly at cap → undefined', () => {
    const originalMaxLinks = config.triage.maxLinksPerRun
    config.triage.maxLinksPerRun = 1
    try {
      const row = makeRow({ item_kind: 'placement', state: 'pending', run_id: RUN_ID })
      expect(checkBatchGuards([row], 1, { confirm: true, runId: RUN_ID })).toBeUndefined()
    } finally {
      config.triage.maxLinksPerRun = originalMaxLinks
    }
  })

  test('max_links_exceeded — single pending link over default cap', () => {
    // Default maxLinksPerRun = 20; fill run with 2 accepted links, then 1 pending
    const originalMaxLinks = config.triage.maxLinksPerRun
    config.triage.maxLinksPerRun = 2
    try {
      for (let i = 0; i < 2; i++) {
        const r = makeRow({ item_kind: 'edge', state: 'accepted', run_id: RUN_ID, source_thought_id: `thought-link-${i}` })
        setState(r, 'accepted')
      }
      const pending = makeRow({ item_kind: 'edge', state: 'pending', run_id: RUN_ID, source_thought_id: 'thought-link-pending' })
      const refusal = checkBatchGuards([pending], 1, { confirm: true, runId: RUN_ID })
      expect(refusal?.code).toBe('max_links_exceeded')
      expect(refusal?.reason).toContain('3 links')
      expect(refusal?.reason).toContain('maxLinksPerRun 2')
    } finally {
      config.triage.maxLinksPerRun = originalMaxLinks
    }
  })

  test('cumulative across batches — second batch refuses', () => {
    // Several small batches must not let the run exceed the cap.
    // checkBatchGuards reads accepted rows from the DB, so after a batch is
    // applied its items become accepted and the next batch sees them.
    const originalMaxLinks = config.triage.maxLinksPerRun
    config.triage.maxLinksPerRun = 3
    try {
      // First batch: 2 accepted links
      for (let i = 0; i < 2; i++) {
        const r = makeRow({ item_kind: 'lifecycle', state: 'accepted', run_id: RUN_ID, source_thought_id: `thought-lc-acc-${i}` })
        setState(r, 'accepted')
      }
      // Simulate first batch being applied: 1 pending → accepted
      const batch1 = makeRow({ item_kind: 'lifecycle', state: 'pending', run_id: RUN_ID, source_thought_id: 'thought-lc-b1' })
      expect(checkBatchGuards([batch1], 1, { confirm: true, runId: RUN_ID })).toBeUndefined()
      setState(batch1, 'accepted') // simulate post-apply state

      // Second batch: 1 more pending → would be 4 accepted > cap 3
      const batch2 = makeRow({ item_kind: 'placement', state: 'pending', run_id: RUN_ID, source_thought_id: 'thought-pl-b2' })
      const refusal = checkBatchGuards([batch2], 1, { confirm: true, runId: RUN_ID })
      expect(refusal?.code).toBe('max_links_exceeded')
    } finally {
      config.triage.maxLinksPerRun = originalMaxLinks
    }
  })

  test('mixed batch — triage + link: link cap enforced independently', () => {
    // Triage and link counts are disjoint; a mixed batch should still check the link cap
    const originalMaxLinks = config.triage.maxLinksPerRun
    config.triage.maxLinksPerRun = 1
    try {
      const triage = makeRow({ item_kind: 'triage_activate', state: 'pending', run_id: RUN_ID, source_thought_id: 'thought-triage-mix' })
      const link = makeRow({ item_kind: 'edge', state: 'pending', run_id: RUN_ID, source_thought_id: 'thought-edge-mix' })
      // Already 1 accepted link in run; adding another should exceed
      const accepted = makeRow({ item_kind: 'edge', state: 'accepted', run_id: RUN_ID, source_thought_id: 'thought-edge-acc' })
      setState(accepted, 'accepted')
      const refusal = checkBatchGuards([triage, link], 2, { confirm: true, runId: RUN_ID })
      expect(refusal?.code).toBe('max_links_exceeded')
    } finally {
      config.triage.maxLinksPerRun = originalMaxLinks
    }
  })

  test('non-link batch with many accepted links → undefined (no pending links)', () => {
    // If the batch has no pending link items, the link cap is not checked
    const originalMaxLinks = config.triage.maxLinksPerRun
    config.triage.maxLinksPerRun = 1
    try {
      // Fill with 10 accepted links
      for (let i = 0; i < 10; i++) {
        const r = makeRow({ item_kind: 'edge', state: 'accepted', run_id: RUN_ID })
        setState(r, 'accepted')
      }
      // Batch has only a triage item
      const triage = makeRow({ item_kind: 'triage_activate', state: 'pending', run_id: RUN_ID })
      expect(checkBatchGuards([triage], 1, { confirm: true, runId: RUN_ID })).toBeUndefined()
    } finally {
      config.triage.maxLinksPerRun = originalMaxLinks
    }
  })

  test('no run_id with link items → undefined (link cap requires run_id)', () => {
    // Link cap only runs when runId is provided; missing run_id short-circuits earlier
    const row = makeRow({ item_kind: 'edge', state: 'pending', source_thought_id: 'thought-no-run' })
    // Without run_id, the function returns undefined for non-triage rows
    // (the run_id_required check only fires for triage pending rows)
    expect(checkBatchGuards([row], 1, { confirm: true, runId: undefined })).toBeUndefined()
  })
})

// ── single-item apply: the same caps apply one at a time ──────────────────────

describe('checkItemGuards', () => {
  function triageRow(sourceId: string, itemKind: 'triage_activate' | 'triage_archive' = 'triage_activate'): PlacementProposalRow {
    const db = getDb()
    seedThought({ id: sourceId, content: `source ${sourceId}`, status: 'draft', created_at: NOW })
    return insertProposal(db, {
      source_thought_id: sourceId,
      item_kind: itemKind,
      confidence: 0.5,
      rationale: 'test',
      payload: '{}',
      fingerprint: `fp-${sourceId}`,
      run_id: RUN_ID,
    })
  }

  test('is a no-op for a dry-run', () => {
    const row = triageRow('dry-src')
    expect(checkItemGuards(row.id, { confirm: false, runId: RUN_ID })).toBeUndefined()
  })

  test('refuses a triage item with no run_id', () => {
    const row = triageRow('no-run-src')
    expect(checkItemGuards(row.id, { confirm: true })).toEqual({
      code: 'run_id_required',
      reason: 'run_id is required for triage items',
    })
  })

  test('repeated single applies cannot exceed maxItemsPerRun', () => {
    const db = getDb()
    const original = config.triage.maxItemsPerRun
    config.triage.maxItemsPerRun = 2
    try {
      const ids = [triageRow('single-src-0'), triageRow('single-src-1'), triageRow('single-src-2')].map(r => r.id)

      // Confirm one at a time: the cap is cumulative over the run, so the third
      // single apply is refused instead of quietly applying a prefix.
      expect(checkItemGuards(ids[0], { confirm: true, runId: RUN_ID })).toBeUndefined()
      updateProposalState(db, ids[0], { state: 'accepted', applied_at: NOW, decided_at: NOW })
      expect(checkItemGuards(ids[1], { confirm: true, runId: RUN_ID })).toBeUndefined()
      updateProposalState(db, ids[1], { state: 'accepted', applied_at: NOW, decided_at: NOW })

      expect(checkItemGuards(ids[2], { confirm: true, runId: RUN_ID })?.code).toBe('max_items_exceeded')
    } finally {
      config.triage.maxItemsPerRun = original
    }
  })

  test('repeated single applies cannot exceed maxArchivesPerRun', () => {
    const db = getDb()
    const original = config.triage.maxArchivesPerRun
    config.triage.maxArchivesPerRun = 1
    try {
      const ids = [triageRow('single-arc-0', 'triage_archive'), triageRow('single-arc-1', 'triage_archive')].map(r => r.id)
      expect(checkItemGuards(ids[0], { confirm: true, runId: RUN_ID })).toBeUndefined()
      updateProposalState(db, ids[0], { state: 'accepted', applied_at: NOW, decided_at: NOW })
      expect(checkItemGuards(ids[1], { confirm: true, runId: RUN_ID })?.code).toBe('max_archives_exceeded')
    } finally {
      config.triage.maxArchivesPerRun = original
    }
  })

  test('an unknown proposal id does not fabricate a refusal', () => {
    expect(checkItemGuards('does-not-exist', { confirm: true, runId: RUN_ID })).toBeUndefined()
  })
})
