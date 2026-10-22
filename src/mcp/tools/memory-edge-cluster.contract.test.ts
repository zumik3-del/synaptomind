/**
 * Contract tests for the new MCP edge and cluster management actions (task #1460).
 *
 * Covers:
 * - `memory_store action=unlink` — dry-run preview, confirm delete, idempotent not_found
 * - `memory_store action=retype` — dry-run preview, confirm retype
 *
 * Follows the pattern from memory-review.contract.test.ts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { config } from '../../config'
import { getDb, closeDb } from '../../db'
import { getEdgePairBetween } from '../../db/edges'
import { closeLogDb } from '../../logging'
import { createTestDb, seedThought, seedEdge } from '../../test/helpers'
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

// ── memory_store action=unlink ─────────────────────────────────────────────────

describe('memory_store unlink', () => {
  test('dry-run (no confirm) → returns preview with edge details, no mutation', async () => {
    const db = getDb()
    const src = seedThought({ content: 'unlink-dry source' })
    const tgt = seedThought({ content: 'unlink-dry target' })
    const edgeId = seedEdge(src, tgt, 'contradicts')

    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'unlink', edge_id: edgeId }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.status).toBe('preview')
    expect(data.edge_id).toBe(edgeId)
    expect(data.edge.source_id).toBe(src)
    expect(data.edge.target_id).toBe(tgt)
    expect(data.edge.type).toBe('contradicts')
    expect(data.consequence).toContain('contradicts')
    expect(data.instruction).toContain('confirm=true')

    // Verify no mutation
    const edge = getEdgePairBetween(db, src, tgt)
    expect(edge).toBeDefined()
    expect(edge!.id).toBe(edgeId)
  })

  test('confirm:true → deletes the edge', async () => {
    const db = getDb()
    const src = seedThought({ content: 'unlink-confirm source' })
    const tgt = seedThought({ content: 'unlink-confirm target' })
    const edgeId = seedEdge(src, tgt, 'supports')

    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'unlink', edge_id: edgeId, confirm: true }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.status).toBe('deleted')
    expect(data.edge_id).toBe(edgeId)

    // Verify edge is gone
    const edge = getEdgePairBetween(db, src, tgt)
    expect(edge).toBeFalsy()
  })

  test('confirm:true on non-existent edge → idempotent not_found', async () => {
    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'unlink', edge_id: 'non-existent-edge', confirm: true }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.status).toBe('not_found')
    expect(data.edge_id).toBe('non-existent-edge')
  })

  test('dry-run on non-existent edge → not_found', async () => {
    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'unlink', edge_id: 'non-existent-edge' }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.status).toBe('not_found')
    expect(data.edge_id).toBe('non-existent-edge')
  })

  test('missing edge_id → error envelope', async () => {
    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'unlink' }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text).toContain('edge_id is required')
  })

  test('double unlink → second confirm returns not_found', async () => {
    const src = seedThought({ content: 'unlink-double source' })
    const tgt = seedThought({ content: 'unlink-double target' })
    const edgeId = seedEdge(src, tgt, 'related')

    // First delete
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'unlink', edge_id: edgeId, confirm: true }
    })

    // Second delete — idempotent
    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'unlink', edge_id: edgeId, confirm: true }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.status).toBe('not_found')
  })
})

// ── memory_store action=retype ─────────────────────────────────────────────────

describe('memory_store retype', () => {
  test('dry-run (no confirm) → returns preview with old/new type, no mutation', async () => {
    const db = getDb()
    const src = seedThought({ content: 'retype-dry source' })
    const tgt = seedThought({ content: 'retype-dry target' })
    const edgeId = seedEdge(src, tgt, 'contradicts')

    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'retype', edge_id: edgeId, new_type: 'supports' }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.status).toBe('preview')
    expect(data.edge_id).toBe(edgeId)
    expect(data.old_type).toBe('contradicts')
    expect(data.new_type).toBe('supports')
    expect(data.source_id).toBe(src)
    expect(data.target_id).toBe(tgt)
    expect(data.consequence).toContain('contradicts')
    expect(data.consequence).toContain('supports')

    // Verify no mutation
    const edge = getEdgePairBetween(db, src, tgt)
    expect(edge).toBeDefined()
    expect(edge!.type).toBe('contradicts')
  })

  test('confirm:true → retypes the edge and returns the FRESH edge_id', async () => {
    const db = getDb()
    const src = seedThought({ content: 'retype-confirm source' })
    const tgt = seedThought({ content: 'retype-confirm target' })
    const edgeId = seedEdge(src, tgt, 'contradicts')

    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'retype', edge_id: edgeId, new_type: 'supports', confirm: true }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.status).toBe('retyped')
    // retypeEdge does delete+insert, so the id changes — the tool must return
    // the fresh id so a chained unlink/retype resolves.
    expect(data.edge_id).toBeDefined()
    expect(data.edge_id).not.toBe(edgeId)
    expect(data.old_type).toBe('contradicts')
    expect(data.new_type).toBe('supports')

    // Verify edge type changed and the stored edge now carries the fresh id
    const edge = getEdgePairBetween(db, src, tgt)
    expect(edge).toBeDefined()
    expect(edge!.type).toBe('supports')
    expect(edge!.id).toBe(data.edge_id)

    // Chained follow-up: the returned fresh id resolves — unlink it
    const unlink = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'unlink', edge_id: data.edge_id, confirm: true }
    })
    const { data: unlinked, isError: unlinkError } = parseResult(unlink)
    expect(unlinkError).toBe(false)
    expect(unlinked.status).toBe('deleted')
    expect(unlinked.edge_id).toBe(data.edge_id)
    expect(getEdgePairBetween(db, src, tgt)).toBeFalsy()
  })

  test('retype to same type → error', async () => {
    const src = seedThought({ content: 'retype-same source' })
    const tgt = seedThought({ content: 'retype-same target' })
    const edgeId = seedEdge(src, tgt, 'supports')

    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'retype', edge_id: edgeId, new_type: 'supports', confirm: true }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text).toContain('already')
  })

  test('retype non-existent edge → error', async () => {
    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'retype', edge_id: 'non-existent', new_type: 'supports', confirm: true }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text).toContain('not found')
  })

  test('missing edge_id → error envelope', async () => {
    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'retype', new_type: 'supports' }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text).toContain('edge_id is required')
  })

  test('missing new_type → error envelope', async () => {
    const src = seedThought({ content: 'retype-missing-type source' })
    const tgt = seedThought({ content: 'retype-missing-type target' })
    const edgeId = seedEdge(src, tgt, 'related')

    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'retype', edge_id: edgeId }
    })
    const { isError } = parseResult(result)
    expect(isError).toBe(true)
  })

  // ── dry-run parity (ADR §2): the preview must never promise a confirm would reject ──

  test('dry-run rejects same-type retype, matching confirm', async () => {
    const src = seedThought({ content: 'retype-dry-same source' })
    const tgt = seedThought({ content: 'retype-dry-same target' })
    const edgeId = seedEdge(src, tgt, 'supports')

    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'retype', edge_id: edgeId, new_type: 'supports' }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text).toContain('already')

    // No mutation
    const edge = getEdgePairBetween(getDb(), src, tgt)
    expect(edge).toBeDefined()
    expect(edge!.id).toBe(edgeId)
    expect(edge!.type).toBe('supports')
  })

  test('dry-run flags constraint-violating retype, matching confirm', async () => {
    const db = getDb()
    const cluster = seedThought({ content: 'retype-dry-constraint cluster', is_cluster: 1 })
    const member = seedThought({ content: 'retype-dry-constraint member' })
    const edgeId = seedEdge(cluster, member, 'cluster')

    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'retype', edge_id: edgeId, new_type: 'related' }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text).toContain("Cluster thoughts cannot have 'related' edges")

    // No mutation — the cluster edge is untouched
    const edge = db.prepare('SELECT * FROM edges WHERE id = ?').get(edgeId) as { type: string } | undefined
    expect(edge).toBeTruthy()
    expect(edge!.type).toBe('cluster')
  })

  test('dry-run on non-existent edge → not_found error, matching confirm', async () => {
    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'retype', edge_id: 'non-existent', new_type: 'supports' }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text).toContain('not found')
  })
})
