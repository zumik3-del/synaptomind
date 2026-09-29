/**
 * Contract tests for the R5 HTTP /api/proposals surface (task #978, epic #964).
 *
 * Covers error envelopes (unknown id, missing param, double reject), status
 * codes, and telemetry `action` values (read on list, write on enqueue/apply/reject).
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
