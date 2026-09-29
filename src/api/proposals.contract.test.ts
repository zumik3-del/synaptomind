/**
 * Contract tests for the R5 HTTP /api/proposals surface (task #978, epic #964).
 *
 * Covers error envelopes (unknown id, missing param, double reject), status
 * codes, telemetry `action` values (read on list, write on enqueue/apply/reject),
 * and the rollback endpoint (ADR §2.8).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { config } from '../config'
import { getDb, closeDb } from '../db'
import { closeLogDb, getLogDb } from '../logging'
import { getEdgePairBetween } from '../db/edges'
import { getThoughtRow } from '../db/thoughts'
import { insertProposal, type PlacementProposalRow } from '../db/placement-proposals'
import { computeFingerprint } from '../services/placement-proposals.service'
import { createTestDb, seedThought } from '../test/helpers'
import { createApp } from './router'

const restartEmbedderMock = mock(() => {})

mock.module('../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: () => [new Float32Array(384)],
  restartEmbedder: restartEmbedderMock,
  isEmbedderReady: () => true
}))

process.env.SYNAPTOMIND_SECRET = 'test-token'
const app = createApp()

async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', 'Bearer test-token')
  return app.request(path, { ...init, headers })
}

function propState(id: string): string {
  const db = getDb()
  const row = db.prepare('SELECT state FROM placement_proposals WHERE id = ?').get(id) as { state: string } | undefined
  return row?.state ?? 'missing'
}

function insertPendingEdge(src: string, tgt: string): PlacementProposalRow {
  const db = getDb()
  const source = getThoughtRow(db, src)
  const target = getThoughtRow(db, tgt)
  if (!source || !target) throw new Error('thought not found in test setup')
  const existing = getEdgePairBetween(db, src, tgt)
  const fp = computeFingerprint({
    sourceId: src,
    sourceUpdatedAt: source.updated_at,
    sourceStatus: source.status,
    targetId: tgt,
    targetUpdatedAt: target.updated_at,
    targetStatus: target.status,
    existingEdgeType: existing?.type ?? null,
  })
  return insertProposal(db, {
    source_thought_id: src,
    item_kind: 'edge',
    target_id: tgt,
    edge_type: 'related',
    confidence: 0.8,
    rationale: 'contract test edge',
    payload: '{}',
    fingerprint: fp,
    direction: 'symmetric',
  })
}

function telemetryRows(): Array<{ action: string; tool_name: string }> {
  const db = getLogDb()
  if (!db) return []
  return db.query('SELECT action, tool_name FROM thought_telemetry ORDER BY rowid').all() as Array<{ action: string; tool_name: string }>
}

/** Temporarily point the log DB at `:memory:` for a telemetry assertion. */
async function withMemoryLogDb<T>(fn: () => T | Promise<T>): Promise<T> {
  closeLogDb()
  const saved = config.logDbPath
  config.logDbPath = ':memory:'
  try {
    return await fn()
  } finally {
    closeLogDb()
    config.logDbPath = saved
  }
}

beforeEach(createTestDb)
afterEach(closeDb)

// ── GET /api/proposals ─────────────────────────────────────────────────────────

describe('GET /api/proposals', () => {
  test('200 with pending rows when the queue has entries', async () => {
    const src = seedThought({ content: 'get-proposals source' })
    const tgt = seedThought({ content: 'get-proposals target' })
    insertPendingEdge(src, tgt)

    const res = await request('/api/proposals')
    expect(res.status).toBe(200)
    const body = await res.json() as unknown[]
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(1)
  })

  test('200 with an empty array when the queue is empty', async () => {
    const res = await request('/api/proposals')
    expect(res.status).toBe(200)
    const body = await res.json() as unknown[]
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(0)
  })

  test('writes telemetry with action=read', async () => {
    await withMemoryLogDb(async () => {
      await request('/api/proposals')
      const rows = telemetryRows()
      expect(rows.length).toBe(1)
      expect(rows[0].action).toBe('read')
      expect(rows[0].tool_name).toBe('list_placement_proposals')
    })
  })
})

// ── POST /api/proposals (enqueue) ─────────────────────────────────────────────

describe('POST /api/proposals', () => {
  test('201 with proposal rows for a valid persisted thought_id', async () => {
    const src = seedThought({ content: 'post-proposals subject marker here' })
    seedThought({ content: 'post-proposals related content elsewhere' })

    const res = await request('/api/proposals', {
      method: 'POST',
      body: JSON.stringify({ thought_id: src }),
      headers: { 'Content-Type': 'application/json' }
    })
    expect(res.status).toBe(201)
    const body = await res.json() as unknown[]
    expect(Array.isArray(body)).toBe(true)
  })

  test('400 when thought_id is missing', async () => {
    const res = await request('/api/proposals', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' }
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error.toLowerCase()).toContain('thoughtid')
  })

  test('404 when thought_id does not exist', async () => {
    const res = await request('/api/proposals', {
      method: 'POST',
      body: JSON.stringify({ thought_id: 'does-not-exist' }),
      headers: { 'Content-Type': 'application/json' }
    })
    expect(res.status).toBe(404)
    const body = await res.json() as { error: string }
    expect(body.error.toLowerCase()).toContain('not found')
  })

  test('writes telemetry with action=write', async () => {
    const src = seedThought({ content: 'telemetry-post-proposals source' })
    await withMemoryLogDb(async () => {
      await request('/api/proposals', {
        method: 'POST',
        body: JSON.stringify({ thought_id: src }),
        headers: { 'Content-Type': 'application/json' }
      })
      const rows = telemetryRows()
      expect(rows.length).toBe(1)
      expect(rows[0].action).toBe('write')
      expect(rows[0].tool_name).toBe('enqueue_placement_proposals')
    })
  })
})

// ── POST /api/proposals/:id/apply ─────────────────────────────────────────────

describe('POST /api/proposals/:id/apply', () => {
  test('dry-run (no confirm) → 200 with dry_run status, no mutation', async () => {
    const src = seedThought({ content: 'apply-api dry source' })
    const tgt = seedThought({ content: 'apply-api dry target' })
    const row = insertPendingEdge(src, tgt)

    const res = await request(`/api/proposals/${row.id}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.status).toBe('dry_run')
    expect(propState(row.id)).toBe('pending')
  })

  test('confirm:true → 200 with accepted status and row transitions', async () => {
    const src = seedThought({ content: 'apply-api confirm source' })
    const tgt = seedThought({ content: 'apply-api confirm target' })
    const row = insertPendingEdge(src, tgt)

    const res = await request(`/api/proposals/${row.id}/apply`, {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
      headers: { 'Content-Type': 'application/json' }
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.status).toBe('accepted')
    expect(propState(row.id)).toBe('accepted')
  })

  test('unknown proposal_id → 404', async () => {
    const res = await request('/api/proposals/no-such-id/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
    expect(res.status).toBe(404)
    const body = await res.json() as { error: string }
    expect(body.error.toLowerCase()).toContain('not found')
  })

  test('writes telemetry with action=write', async () => {
    const src = seedThought({ content: 'telemetry-apply-api source' })
    const tgt = seedThought({ content: 'telemetry-apply-api target' })
    const row = insertPendingEdge(src, tgt)
    await withMemoryLogDb(async () => {
      await request(`/api/proposals/${row.id}/apply`, {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
        headers: { 'Content-Type': 'application/json' }
      })
      const rows = telemetryRows()
      expect(rows.length).toBe(1)
      expect(rows[0].action).toBe('write')
      expect(rows[0].tool_name).toBe('apply_placement_proposal')
    })
  })
})

// ── POST /api/proposals/:id/reject ────────────────────────────────────────────

describe('POST /api/proposals/:id/reject', () => {
  test('200 with rejected state; returns audit metadata', async () => {
    const src = seedThought({ content: 'reject-api source' })
    const tgt = seedThought({ content: 'reject-api target' })
    const row = insertPendingEdge(src, tgt)

    const res = await request(`/api/proposals/${row.id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.state).toBe('rejected')
    expect(typeof body.decided_at).toBe('string')
    expect(propState(row.id)).toBe('rejected')
  })

  test('double reject → 400 ValidationError', async () => {
    const src = seedThought({ content: 'double-reject source' })
    const tgt = seedThought({ content: 'double-reject target' })
    const row = insertPendingEdge(src, tgt)

    await request(`/api/proposals/${row.id}/reject`, { method: 'POST' })
    const res = await request(`/api/proposals/${row.id}/reject`, { method: 'POST' })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error.toLowerCase()).toContain("not 'pending'")
  })

  test('unknown proposal_id → 404', async () => {
    const res = await request('/api/proposals/no-such-id/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
    expect(res.status).toBe(404)
    const body = await res.json() as { error: string }
    expect(body.error.toLowerCase()).toContain('not found')
  })

  test('writes telemetry with action=write', async () => {
    const src = seedThought({ content: 'telemetry-reject-api source' })
    const tgt = seedThought({ content: 'telemetry-reject-api target' })
    const row = insertPendingEdge(src, tgt)
    await withMemoryLogDb(async () => {
      await request(`/api/proposals/${row.id}/reject`, { method: 'POST' })
      const rows = telemetryRows()
      expect(rows.length).toBe(1)
      expect(rows[0].action).toBe('write')
      expect(rows[0].tool_name).toBe('reject_placement_proposal')
    })
  })
})

// ── POST /api/proposals/rollback ──────────────────────────────────────────────

/** Insert an accepted edge proposal row with a real edge so rollback can invert it. */
function insertAcceptedEdgeRunWithRunId(
  src: string,
  tgt: string,
  runId: string
): { rowId: string; edgeId: string } {
  const db = getDb()
  // Create the actual edge that the proposal would have created.
  const edgeId = Bun.randomUUIDv7()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO edges (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, 'related', ?)`
  ).run(edgeId, src, tgt, now)
  // Compute a real fingerprint so rollback does not skip on drift.
  const source = getThoughtRow(db, src)
  const target = getThoughtRow(db, tgt)
  if (!source || !target) throw new Error('thought not found in test setup')
  const fp = computeFingerprint({
    sourceId: src,
    sourceUpdatedAt: source.updated_at,
    sourceStatus: source.status,
    targetId: tgt,
    targetUpdatedAt: target.updated_at,
    targetStatus: target.status,
    existingEdgeType: 'related',
  })
  // Insert an accepted proposal row with run_id and result referencing the edge.
  const rowId = Bun.randomUUIDv7()
  db.prepare(`
    INSERT INTO placement_proposals (
      id, project_id, source_thought_id, item_kind, target_id, edge_type, lifecycle_action,
      direction, confidence, rationale, rule_id, payload, state, fingerprint, created_at,
      expires_at, run_id, decided_at, decided_by, applied_at, result
    ) VALUES (?, 'default', ?, 'edge', ?, 'related', null, 'symmetric',
      0.8, 'contract test edge', null, '{}', 'accepted', ?, ?,
      NULL, ?, ?, ?, ?, ?)
  `).run(rowId, src, tgt, fp, now, runId, now, now, now, JSON.stringify({ edge_id: edgeId }))
  return { rowId, edgeId }
}

describe('POST /api/proposals/rollback', () => {
  test('400 when run_id is missing', async () => {
    const res = await request('/api/proposals/rollback', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' }
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error.toLowerCase()).toContain('run_id')
  })

  test('200 dry-run (no confirm) returns a report with reverted items, no graph mutation', async () => {
    const src = seedThought({ content: 'rollback dry source' })
    const tgt = seedThought({ content: 'rollback dry target' })
    const { rowId, edgeId } = insertAcceptedEdgeRunWithRunId(src, tgt, 'run-dry')

    const res = await request('/api/proposals/rollback', {
      method: 'POST',
      body: JSON.stringify({ run_id: 'run-dry' }),
      headers: { 'Content-Type': 'application/json' }
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.run_id).toBe('run-dry')
    expect(body.confirm).toBe(false)
    expect(Array.isArray(body.items)).toBe(true)
    expect((body.items as unknown[]).length).toBe(1)
    expect((body.items as Array<Record<string, unknown>>)[0].action).toBe('reverted')
    // Edge still exists — dry-run does not mutate.
    const edge = getDb().prepare('SELECT id FROM edges WHERE id = ?').get(edgeId)
    expect(edge).toBeDefined()
    // Row stays accepted — dry-run does not change state.
    expect(propState(rowId)).toBe('accepted')
  })

  test('200 with confirm:true rolls back accepted rows; edge is deleted and row state becomes rolled_back', async () => {
    const src = seedThought({ content: 'rollback confirm source' })
    const tgt = seedThought({ content: 'rollback confirm target' })
    const { rowId, edgeId } = insertAcceptedEdgeRunWithRunId(src, tgt, 'run-confirm')

    const res = await request('/api/proposals/rollback', {
      method: 'POST',
      body: JSON.stringify({ run_id: 'run-confirm', confirm: true }),
      headers: { 'Content-Type': 'application/json' }
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.run_id).toBe('run-confirm')
    expect(body.confirm).toBe(true)
    expect((body.items as unknown[]).length).toBe(1)
    expect((body.items as Array<Record<string, unknown>>)[0].action).toBe('reverted')
    expect(body.summary).toBeDefined()
    // Edge deleted by rollback.
    const edge = getDb().prepare('SELECT id FROM edges WHERE id = ?').get(edgeId)
    expect(edge).toBeFalsy()
    // Row state transitions to rolled_back.
    expect(propState(rowId)).toBe('rolled_back')
  })

  test('unknown run_id → 200 with empty items report', async () => {
    const res = await request('/api/proposals/rollback', {
      method: 'POST',
      body: JSON.stringify({ run_id: 'no-such-run', confirm: true }),
      headers: { 'Content-Type': 'application/json' }
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.run_id).toBe('no-such-run')
    expect(body.items).toEqual([])
    expect(body.summary).toEqual({ reverted: 0, skipped: 0, refused: 0 })
  })

  test('writes telemetry with action=write', async () => {
    const src = seedThought({ content: 'telemetry-rollback source' })
    const tgt = seedThought({ content: 'telemetry-rollback target' })
    insertAcceptedEdgeRunWithRunId(src, tgt, 'run-tel')
    await withMemoryLogDb(async () => {
      await request('/api/proposals/rollback', {
        method: 'POST',
        body: JSON.stringify({ run_id: 'run-tel', confirm: true }),
        headers: { 'Content-Type': 'application/json' }
      })
      const rows = telemetryRows()
      expect(rows.length).toBe(1)
      expect(rows[0].action).toBe('write')
      expect(rows[0].tool_name).toBe('rollback_placement_proposals')
    })
  })
})
