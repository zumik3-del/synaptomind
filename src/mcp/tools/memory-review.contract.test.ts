/**
 * Contract tests for the R5 MCP surface (task #978, epic #964).
 *
 * Covers `memory_review` actions (`enqueue`/`list`/`apply`/`apply_batch`/`reject`):
 * valid, missing param, unknown id, error envelopes, draft guard, read-only
 * list, write-action telemetry (action='write'), and a static assertion that
 * no read handler in review.ts reaches `applyProposal` / `applyBatch`.
 *
 * The embedder is mocked so `enqueue`'s happy path runs end-to-end.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../../config'
import { getDb, closeDb } from '../../db'
import { getEdgePairBetween } from '../../db/edges'
import { getThoughtRow } from '../../db/thoughts'
import { closeLogDb, getLogDb } from '../../logging'
import { createTestDb, seedThought } from '../../test/helpers'
import { insertProposal, type PlacementProposalRow } from '../../db/placement-proposals'
import { computeFingerprint } from '../../services/placement-proposals.service'
import { registerAllMemoryTools } from '.'

mock.module('../../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: () => [new Float32Array(384)],
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

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

/** Insert a pending edge proposal with a real fingerprint (from current graph snapshot). */
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
afterEach(() => {
  closeLogDb()
  closeDb()
})

beforeAll(async () => {
  client = await setupClient()
})

// ── enqueue ────────────────────────────────────────────────────────────────────

describe('memory_review enqueue', () => {
  test('valid thought_id → success, returns array (possibly empty if engine degrades)', async () => {
    const src = seedThought({ content: 'enqueue valid subject marker' })
    seedThought({ content: 'enqueue valid related content here' })

    const result = await client.callTool({
      name: 'memory_review',
      arguments: { action: 'enqueue', thought_id: src }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(Array.isArray(data)).toBe(true)
  })

  test('missing thought_id → error envelope with a clear message', async () => {
    const result = await client.callTool({
      name: 'memory_review',
      arguments: { action: 'enqueue' }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text).toContain('thought_id is required')
  })

  test('draft sentinel id is rejected (error envelope)', async () => {
    const result = await client.callTool({
      name: 'memory_review',
      arguments: { action: 'enqueue', thought_id: '(draft)' }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text.toLowerCase()).toContain('(draft)')
    expect(text.toLowerCase()).toContain('not found')
  })

  test('unknown thought_id → error envelope', async () => {
    const result = await client.callTool({
      name: 'memory_review',
      arguments: { action: 'enqueue', thought_id: 'does-not-exist' }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text.toLowerCase()).toContain('not found')
  })
})

// ── list ───────────────────────────────────────────────────────────────────────

describe('memory_review list', () => {
  test('returns an array; seeded pending rows appear', async () => {
    const src = seedThought({ content: 'list-read-only source' })
    const tgt = seedThought({ content: 'list-read-only target' })
    insertPendingEdge(src, tgt)

    const result = await client.callTool({
      name: 'memory_review',
      arguments: { action: 'list' }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThanOrEqual(1)
  })

  test('list does not mutate the queue (read-only)', async () => {
    const db = getDb()
    const src = seedThought({ content: 'list-ro source' })
    const tgt = seedThought({ content: 'list-ro target' })
    const row = insertPendingEdge(src, tgt)

    const beforeCount = (db.prepare('SELECT COUNT(*) AS n FROM placement_proposals').get() as { n: number }).n
    await client.callTool({ name: 'memory_review', arguments: { action: 'list' } })
    const afterCount = (db.prepare('SELECT COUNT(*) AS n FROM placement_proposals').get() as { n: number }).n

    expect(afterCount).toBe(beforeCount)
    expect(propState(db, row.id)).toBe('pending')
  })

  test('list with state filter returns only matching state', async () => {
    const db = getDb()
    const src = seedThought({ content: 'list-filter source' })
    const tgt = seedThought({ content: 'list-filter target' })
    const row = insertPendingEdge(src, tgt)

    // Reject one so it becomes terminal.
    await client.callTool({ name: 'memory_review', arguments: { action: 'reject', proposal_id: row.id } })
    expect(propState(db, row.id)).toBe('rejected')

    const result = await client.callTool({
      name: 'memory_review',
      arguments: { action: 'list', state: 'rejected' }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.some((r: PlacementProposalRow) => r.id === row.id)).toBe(true)
  })
})

// ── apply ──────────────────────────────────────────────────────────────────────

describe('memory_review apply', () => {
  test('dry-run (no confirm) → returns dry_run status, no mutation', async () => {
    const db = getDb()
    const src = seedThought({ content: 'apply-dry source' })
    const tgt = seedThought({ content: 'apply-dry target' })
    const row = insertPendingEdge(src, tgt)

    const result = await client.callTool({
      name: 'memory_review',
      arguments: { action: 'apply', proposal_id: row.id }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.status).toBe('dry_run')
    expect(Array.isArray(data.calls)).toBe(true)
    expect(propState(db, row.id)).toBe('pending')
  })

  test('confirm:true → executes the write, row transitions to accepted', async () => {
    const db = getDb()
    const src = seedThought({ content: 'apply-confirm source' })
    const tgt = seedThought({ content: 'apply-confirm target' })
    const row = insertPendingEdge(src, tgt)

    const result = await client.callTool({
      name: 'memory_review',
      arguments: { action: 'apply', proposal_id: row.id, confirm: true }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.status).toBe('accepted')
    expect(propState(db, row.id)).toBe('accepted')
  })

  test('unknown proposal_id → error envelope', async () => {
    const result = await client.callTool({
      name: 'memory_review',
      arguments: { action: 'apply', proposal_id: 'no-such-id' }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text.toLowerCase()).toContain('not found')
  })

  test('missing proposal_id → error envelope', async () => {
    const result = await client.callTool({
      name: 'memory_review',
      arguments: { action: 'apply' }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text).toContain('proposal_id is required')
  })
})

// ── apply_batch ────────────────────────────────────────────────────────────────

describe('memory_review apply_batch', () => {
  test('applies multiple proposals independently, returns results and errors', async () => {
    const s1 = seedThought({ content: 'batch-1 source' })
    const t1 = seedThought({ content: 'batch-1 target' })
    const s2 = seedThought({ content: 'batch-2 source' })
    const t2 = seedThought({ content: 'batch-2 target' })
    const okRow = insertPendingEdge(s1, t1)
    insertPendingEdge(s2, t2)

    const result = await client.callTool({
      name: 'memory_review',
      arguments: {
        action: 'apply_batch',
        proposal_ids: [okRow.id, 'missing-id']
      }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(Array.isArray(data.results)).toBe(true)
    expect(Array.isArray(data.errors)).toBe(true)
    expect(data.errors.length).toBeGreaterThanOrEqual(1)
    expect(data.errors.some((e: { proposal_id: string }) => e.proposal_id === 'missing-id')).toBe(true)
  })

  test('empty proposal_ids → error envelope', async () => {
    const result = await client.callTool({
      name: 'memory_review',
      arguments: { action: 'apply_batch', proposal_ids: [] }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text).toContain('non-empty array')
  })

  test('missing proposal_ids → error envelope', async () => {
    const result = await client.callTool({
      name: 'memory_review',
      arguments: { action: 'apply_batch' }
    })
    const { isError } = parseResult(result)
    expect(isError).toBe(true)
  })
})

// ── reject ─────────────────────────────────────────────────────────────────────

describe('memory_review reject', () => {
  test('pending → rejected; returns state and decided_by', async () => {
    const db = getDb()
    const src = seedThought({ content: 'reject-source' })
    const tgt = seedThought({ content: 'reject-target' })
    const row = insertPendingEdge(src, tgt)

    const result = await client.callTool({
      name: 'memory_review',
      arguments: { action: 'reject', proposal_id: row.id }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.state).toBe('rejected')
    expect(typeof data.decided_at).toBe('string')
    expect(propState(db, row.id)).toBe('rejected')
  })

  test('double reject → error envelope', async () => {
    const src = seedThought({ content: 'double-reject source' })
    const tgt = seedThought({ content: 'double-reject target' })
    const row = insertPendingEdge(src, tgt)

    await client.callTool({ name: 'memory_review', arguments: { action: 'reject', proposal_id: row.id } })
    const result = await client.callTool({
      name: 'memory_review',
      arguments: { action: 'reject', proposal_id: row.id }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text.toLowerCase()).toContain("is 'rejected', not 'pending'")
  })

  test('unknown proposal_id → error envelope', async () => {
    const result = await client.callTool({
      name: 'memory_review',
      arguments: { action: 'reject', proposal_id: 'no-such-id' }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text.toLowerCase()).toContain('not found')
  })

  test('missing proposal_id → error envelope', async () => {
    const result = await client.callTool({
      name: 'memory_review',
      arguments: { action: 'reject' }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text).toContain('proposal_id is required')
  })
})

// ── telemetry: write vs read action mapping ───────────────────────────────────

describe('memory_review telemetry', () => {
  test('enqueue writes action=write, tool=enqueue_placement_proposals', async () => {
    const src = seedThought({ content: 'telemetry-enqueue source' })
    seedThought({ content: 'telemetry-enqueue target' })
    await client.callTool({ name: 'memory_review', arguments: { action: 'enqueue', thought_id: src } })
    const rows = telemetryRows()
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const last = rows[rows.length - 1]
    expect(last.action).toBe('write')
    expect(last.tool_name).toBe('enqueue_placement_proposals')
  })

  test('list writes action=read, tool=list_placement_proposals', async () => {
    await client.callTool({ name: 'memory_review', arguments: { action: 'list' } })
    const rows = telemetryRows()
    const last = rows[rows.length - 1]
    expect(last.action).toBe('read')
    expect(last.tool_name).toBe('list_placement_proposals')
  })

  test('apply writes action=write, tool=apply_placement_proposal', async () => {
    const src = seedThought({ content: 'telemetry-apply source' })
    const tgt = seedThought({ content: 'telemetry-apply target' })
    const row = insertPendingEdge(src, tgt)
    await client.callTool({ name: 'memory_review', arguments: { action: 'apply', proposal_id: row.id } })
    const rows = telemetryRows()
    const last = rows[rows.length - 1]
    expect(last.action).toBe('write')
    expect(last.tool_name).toBe('apply_placement_proposal')
  })

  test('reject writes action=write, tool=reject_placement_proposal', async () => {
    const src = seedThought({ content: 'telemetry-reject source' })
    const tgt = seedThought({ content: 'telemetry-reject target' })
    const row = insertPendingEdge(src, tgt)
    await client.callTool({ name: 'memory_review', arguments: { action: 'reject', proposal_id: row.id } })
    const rows = telemetryRows()
    const last = rows[rows.length - 1]
    expect(last.action).toBe('write')
    expect(last.tool_name).toBe('reject_placement_proposal')
  })
})

// ── static assertion: no read handler reaches apply ───────────────────────────

describe('static: no read handler in review.ts calls apply* functions', () => {
  const REVIEW_PATH = join(import.meta.dir, 'review.ts')
  const SOURCE = readFileSync(REVIEW_PATH, 'utf8')

  test('list handler does not reference applyProposal or applyBatch', () => {
    // Extract the list handler block.
    const listMatch = SOURCE.match(/list:\s*\{[\s\S]*?\n\s*\}/)
    expect(listMatch).not.toBeNull()
    const listBlock = listMatch![0]
    expect(listBlock).not.toMatch(/applyProposal|applyBatch/)
  })

  test('enqueue handler does not reference applyProposal or applyBatch', () => {
    const enqueueMatch = SOURCE.match(/enqueue:\s*\{[\s\S]*?\n\s*\}/)
    expect(enqueueMatch).not.toBeNull()
    const enqueueBlock = enqueueMatch![0]
    expect(enqueueBlock).not.toMatch(/applyProposal|applyBatch/)
  })

  test('only apply and apply_batch handlers call apply* functions', () => {
    const applyFnPattern = /applyProposal|applyBatch/
    const handlerKeys = ['enqueue', 'list', 'apply', 'apply_batch', 'reject']
    const handlersWithApply = handlerKeys.filter(key => {
      const re = new RegExp(`${key}:\\s*\\{([\\s\\S]*?\\n\\s*\\})`)
      const m = re.exec(SOURCE)
      return m !== null && applyFnPattern.test(m[1])
    })
    expect(handlersWithApply.sort()).toEqual(['apply', 'apply_batch'])
  })
})
