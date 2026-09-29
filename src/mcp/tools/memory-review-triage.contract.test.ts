/**
 * Contract tests for the R5 MCP surface — triage triage focus (task #1008).
 *
 * Covers `memory_review` actions for triage items (`triage_activate` /
 * `triage_archive`): item_kind list filter, run_id required on apply,
 * requireDryRunFirst guard, apply_batch cap refusal, rollback preview +
 * confirm, and telemetry action mapping for rollback/apply_batch.
 */
import { afterEach, beforeEach, beforeAll, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { config } from '../../config'
import { closeDb, getDb } from '../../db'
import { closeLogDb, getLogDb } from '../../logging'
import { createTestDb, seedThought } from '../../test/helpers'
import { insertProposal } from '../../db/placement-proposals'
import { computeFingerprint } from '../../services/placement-proposals.service'
import { getThoughtRow } from '../../db/thoughts'
import { getEdgePairBetween } from '../../db/edges'
import { insertPendingTriage } from '../../services/triage-apply-helpers'
import { registerAllMemoryTools } from '.'

let client: Client

async function setupClient(): Promise<Client> {
  const s = new McpServer({ name: 'test', version: '0.0.0' })
  registerAllMemoryTools(s)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await s.connect(serverTransport)
  const c = new Client({ name: 'test-client', version: '0.0.0' })
  await c.connect(clientTransport)
  return c
}

function parseResult(result: unknown): { data: any; isError: boolean; text: string } {
  const r = result as { content: Array<{ type: string; text: string }>; isError?: boolean }
  const text = r.content?.[0]?.text ?? '{}'
  let parsed: unknown = text
  try { parsed = JSON.parse(text) } catch { /* keep text */ }
  return { data: parsed, isError: r.isError === true, text }
}

function propState(db: Database, id: string): string {
  const row = db.prepare('SELECT state FROM placement_proposals WHERE id = ?').get(id) as { state: string } | undefined
  return row?.state ?? 'missing'
}

function telemetryRows(): Array<{ action: string; tool_name: string }> {
  const db = getLogDb()
  if (!db) return []
  return db.query('SELECT action, tool_name FROM thought_telemetry ORDER BY rowid').all() as Array<{ action: string; tool_name: string }>
}

function useMemoryLogDb(): void {
  closeLogDb()
  config.logDbPath = ':memory:'
}

beforeEach(createTestDb)
beforeEach(useMemoryLogDb)
afterEach(() => { closeLogDb(); closeDb() })

beforeAll(async () => { client = await setupClient() })

// ── list item_kind filter ─────────────────────────────────────────────────────

describe('memory_review list item_kind filter (triage)', () => {
  test('item_kind=triage_activate returns only triage_activate rows', async () => {
    const db = getDb()
    const srcAct = seedThought({ content: 'list-filter act source', status: 'draft' })
    const srcArc = seedThought({ content: 'list-filter arc source', status: 'draft' })
    const tgtArc = seedThought({ content: 'list-filter arc target', status: 'active' })
    insertPendingTriage(db, 'triage_activate', srcAct)
    insertPendingTriage(db, 'triage_archive', srcArc, tgtArc)
    // Seed an edge row so the filter is meaningful.
    const s = seedThought({ content: 'list-filter edge source' })
    const t = seedThought({ content: 'list-filter edge target' })
    const fp = computeFingerprint({
      sourceId: s, sourceUpdatedAt: getThoughtRow(db, s)!.updated_at, sourceStatus: 'active',
      targetId: t, targetUpdatedAt: getThoughtRow(db, t)!.updated_at, targetStatus: 'active',
      existingEdgeType: getEdgePairBetween(db, s, t)?.type ?? null
    })
    insertProposal(db, { source_thought_id: s, item_kind: 'edge', target_id: t, edge_type: 'related',
      confidence: 0.8, rationale: 'edge', payload: '{}', fingerprint: fp })

    const result = await client.callTool({ name: 'memory_review', arguments: { action: 'list', item_kind: 'triage_activate' } })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(Array.isArray(data)).toBe(true)
    expect(data.every((r: { item_kind: string }) => r.item_kind === 'triage_activate')).toBe(true)
    expect(data.some((r: { id: string }) => {
      const row = db.prepare('SELECT source_thought_id FROM placement_proposals WHERE id = ?').get(r.id) as { source_thought_id: string } | undefined
      return row?.source_thought_id === srcAct
    })).toBe(true)
  })
})

// ── apply on triage: run_id + dry-run-first ────────────────────────────────────

describe('memory_review apply triage run_id + dry-run-first', () => {
  test('apply without run_id → refused', async () => {
    const db = getDb()
    const s = seedThought({ content: 'apply-no-runid source', status: 'draft' })
    const row = insertPendingTriage(db, 'triage_activate', s)
    const result = await client.callTool({
      name: 'memory_review', arguments: { action: 'apply', proposal_id: row.id, confirm: true }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.status).toBe('refused')
    expect(data.refusal.code).toBe('run_id_required')
    expect(propState(db, row.id)).toBe('pending')
  })

  test('apply without prior dry-run + run_id → refused (requireDryRunFirst)', async () => {
    const db = getDb()
    const s = seedThought({ content: 'apply-no-dryrun source', status: 'draft' })
    const row = insertPendingTriage(db, 'triage_activate', s)
    const result = await client.callTool({
      name: 'memory_review', arguments: { action: 'apply', proposal_id: row.id, confirm: true, run_id: 'run-dr' }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.status).toBe('refused')
    expect(data.refusal.code).toBe('dry_run_required')
    expect(propState(db, row.id)).toBe('pending')
  })

  test('dry-run then confirm → accepted with run_id envelope', async () => {
    const db = getDb()
    const s = seedThought({ content: 'apply-confirm source', status: 'draft' })
    const row = insertPendingTriage(db, 'triage_activate', s)
    // Step 1: dry-run preview.
    const dry = await client.callTool({
      name: 'memory_review', arguments: { action: 'apply', proposal_id: row.id, confirm: false, run_id: 'run-confirm' }
    })
    const { data: dryData, isError: dryErr } = parseResult(dry)
    expect(dryErr).toBe(false)
    expect(dryData.status).toBe('dry_run')
    expect(propState(db, row.id)).toBe('pending')
    // Step 2: confirm.
    const confirmed = await client.callTool({
      name: 'memory_review', arguments: { action: 'apply', proposal_id: row.id, confirm: true, run_id: 'run-confirm' }
    })
    const { data: confData } = parseResult(confirmed)
    expect(confData.status).toBe('accepted')
    expect(propState(db, row.id)).toBe('accepted')
    expect(getThoughtRow(db, s)!.status).toBe('active')
  })
})

// ── apply_batch cap refusal ────────────────────────────────────────────────────

describe('memory_review apply_batch cap refusal', () => {
  test('exceeding maxItemsPerRun refuses the whole batch and leaves rows pending', async () => {
    const db = getDb()
    const originalMax = config.triage.maxItemsPerRun
    config.triage.maxItemsPerRun = 1
    try {
      const s1 = seedThought({ content: 'batch-cap s1', status: 'draft' })
      const row1 =       insertPendingTriage(db, 'triage_activate', s1)
      // Apply one row to fill the run (dry-run then confirm per requireDryRunFirst).
      await client.callTool({
        name: 'memory_review', arguments: { action: 'apply', proposal_id: row1.id, confirm: false, run_id: 'run-cap' }
      })
      await client.callTool({
        name: 'memory_review', arguments: { action: 'apply', proposal_id: row1.id, confirm: true, run_id: 'run-cap' }
      })
      expect(propState(db, row1.id)).toBe('accepted')
      // Insert a second pending row for the same run.
      const s2 = seedThought({ content: 'batch-cap s2', status: 'draft' })
      const row2 = insertPendingTriage(db, 'triage_activate', s2)
      expect(propState(db, row2.id)).toBe('pending')
      // Batch applying row2 would push the run to 3 > maxItemsPerRun=2.
      const result = await client.callTool({
        name: 'memory_review', arguments: { action: 'apply_batch', proposal_ids: [row2.id], confirm: true, run_id: 'run-cap' }
      })
      const { data, isError } = parseResult(result)
      expect(isError).toBe(false)
      expect(data.refused).toBeDefined()
      expect(data.refused.code).toBe('max_items_exceeded')
      expect(data.results).toEqual([])
      // The pending row must stay pending.
      expect(propState(db, row2.id)).toBe('pending')
    } finally {
      config.triage.maxItemsPerRun = originalMax
    }
  })
})

// ── rollback: dry-run then confirm ─────────────────────────────────────────────

describe('memory_review rollback triage', () => {
  test('dry-run reports reverted; confirm transitions to rolled_back', async () => {
    const db = getDb()
    const s = seedThought({ content: 'rollback source', status: 'draft' })
    const row = insertPendingTriage(db, 'triage_activate', s)
    // Apply the row to make it accepted (part of a run): dry-run then confirm.
    await client.callTool({
      name: 'memory_review', arguments: { action: 'apply', proposal_id: row.id, confirm: false, run_id: 'run-rb' }
    })
    await client.callTool({
      name: 'memory_review', arguments: { action: 'apply', proposal_id: row.id, confirm: true, run_id: 'run-rb' }
    })
    expect(propState(db, row.id)).toBe('accepted')
    expect(getThoughtRow(db, s)!.status).toBe('active')
    // Dry-run rollback.
    const dry = await client.callTool({
      name: 'memory_review', arguments: { action: 'rollback', run_id: 'run-rb', confirm: false }
    })
    const { data: dryData, isError: dryErr } = parseResult(dry)
    expect(dryErr).toBe(false)
    expect(dryData.confirm).toBe(false)
    expect(dryData.summary.reverted).toBe(1)
    expect(propState(db, row.id)).toBe('accepted') // not mutated
    // Confirm rollback.
    const confirmed = await client.callTool({
      name: 'memory_review', arguments: { action: 'rollback', run_id: 'run-rb', confirm: true }
    })
    const { data: confData } = parseResult(confirmed)
    expect(confData.confirm).toBe(true)
    expect(confData.summary.reverted).toBe(1)
    expect(propState(db, row.id)).toBe('rolled_back')
    expect(getThoughtRow(db, s)!.status).toBe('draft') // reverted
  })
})

// ── telemetry: rollback and apply_batch are writes ─────────────────────────────

describe('memory_review telemetry (triage actions)', () => {
  test('rollback writes action=write, tool=rollback_placement_proposals', async () => {
    const db = getDb()
    const s = seedThought({ content: 'telemetry-rb source', status: 'draft' })
    const row = insertPendingTriage(db, 'triage_activate', s)
    await client.callTool({ name: 'memory_review', arguments: { action: 'apply', proposal_id: row.id, confirm: true, run_id: 'run-telem-rb' } })
    await client.callTool({ name: 'memory_review', arguments: { action: 'rollback', run_id: 'run-telem-rb', confirm: true } })
    const rows = telemetryRows()
    const last = rows[rows.length - 1]
    expect(last.action).toBe('write')
    expect(last.tool_name).toBe('rollback_placement_proposals')
  })

  test('apply_batch writes action=write, tool=apply_placement_proposals', async () => {
    const db = getDb()
    const s = seedThought({ content: 'telemetry-batch source', status: 'draft' })
    const row = insertPendingTriage(db, 'triage_activate', s)
    await client.callTool({ name: 'memory_review', arguments: { action: 'apply_batch', proposal_ids: [row.id], confirm: true, run_id: 'run-telem-batch' } })
    const rows = telemetryRows()
    const last = rows[rows.length - 1]
    expect(last.action).toBe('write')
    expect(last.tool_name).toBe('apply_placement_proposals')
  })
})
