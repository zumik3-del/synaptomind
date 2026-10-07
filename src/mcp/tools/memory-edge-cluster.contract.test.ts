/**
 * Contract tests for the new MCP edge and cluster management actions (task #1460).
 *
 * Covers:
 * - `memory_store action=unlink` — dry-run preview, confirm delete, idempotent not_found
 * - `memory_store action=retype` — dry-run preview, confirm retype
 * - `memory_crystallize action=cluster_remove` — dry-run preview, confirm remove
 * - `memory_crystallize action=cluster_dissolve` — dry-run preview, confirm dissolve
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
import { getThoughtRow } from '../../db/thoughts'
import { closeLogDb } from '../../logging'
import { createTestDb, seedThought, seedEdge } from '../../test/helpers'
import { createClusterService } from '../../services/cluster.service'
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

// ── memory_crystallize action=cluster_remove ───────────────────────────────────

describe('memory_crystallize cluster_remove', () => {
  test('dry-run (no confirm) → returns preview with edge_id, no mutation', async () => {
    const db = getDb()
    const t1 = seedThought({ content: 'cluster-remove-dry member' })
    const t2 = seedThought({ content: 'cluster-remove-dry member 2' })
    const { cluster } = createClusterService({ thoughtIds: [t1, t2], title: 'test cluster' })

    const result = await client.callTool({
      name: 'memory_crystallize',
      arguments: { action: 'cluster_remove', cluster_id: cluster.id, thought_id: t1 }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.status).toBe('preview')
    expect(data.cluster_id).toBe(cluster.id)
    expect(data.thought_id).toBe(t1)
    expect(data.edge_id).toBeDefined()
    expect(data.consequence).toContain('standalone')

    // Verify no mutation
    const edge = db.prepare('SELECT * FROM edges WHERE source_id = ? AND target_id = ? AND type = ?')
      .get(cluster.id, t1, 'cluster')
    expect(edge).toBeTruthy()
  })

  test('confirm:true → removes the member edge, thought still exists', async () => {
    const db = getDb()
    const t1 = seedThought({ content: 'cluster-remove-confirm member' })
    const t2 = seedThought({ content: 'cluster-remove-confirm member 2' })
    const { cluster } = createClusterService({ thoughtIds: [t1, t2], title: 'test cluster' })

    const result = await client.callTool({
      name: 'memory_crystallize',
      arguments: { action: 'cluster_remove', cluster_id: cluster.id, thought_id: t1, confirm: true }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.status).toBe('removed')
    expect(data.cluster_id).toBe(cluster.id)
    expect(data.thought_id).toBe(t1)
    expect(data.edge_id).toBeDefined()

    // Verify edge is gone
    const edge = db.prepare('SELECT * FROM edges WHERE source_id = ? AND target_id = ? AND type = ?')
      .get(cluster.id, t1, 'cluster')
    expect(edge).toBeFalsy()

    // Verify thought still exists
    const thought = getThoughtRow(db, t1)
    expect(thought).toBeDefined()

    // Verify other member still in cluster
    const edge2 = db.prepare('SELECT * FROM edges WHERE source_id = ? AND target_id = ? AND type = ?')
      .get(cluster.id, t2, 'cluster')
    expect(edge2).toBeTruthy()
  })

  test('cluster_remove with non-member thought → error', async () => {
    const t1 = seedThought({ content: 'cluster-remove-nonmember' })
    const t2 = seedThought({ content: 'cluster-remove-nonmember 2' })
    const { cluster } = createClusterService({ thoughtIds: [t1], title: 'test cluster' })

    const result = await client.callTool({
      name: 'memory_crystallize',
      arguments: { action: 'cluster_remove', cluster_id: cluster.id, thought_id: t2 }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text).toContain('not a member')
  })

  test('cluster_remove with non-existent cluster → error', async () => {
    const t1 = seedThought({ content: 'cluster-remove-no-cluster' })

    const result = await client.callTool({
      name: 'memory_crystallize',
      arguments: { action: 'cluster_remove', cluster_id: 'non-existent', thought_id: t1 }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text).toContain('not found')
  })

  test('missing cluster_id → error envelope', async () => {
    const result = await client.callTool({
      name: 'memory_crystallize',
      arguments: { action: 'cluster_remove', thought_id: 'some-thought' }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text).toContain('cluster_id is required')
  })

  test('missing thought_id → error envelope', async () => {
    const result = await client.callTool({
      name: 'memory_crystallize',
      arguments: { action: 'cluster_remove', cluster_id: 'some-cluster' }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text).toContain('thought_id is required')
  })
})

// ── memory_crystallize action=cluster_dissolve ─────────────────────────────────

describe('memory_crystallize cluster_dissolve', () => {
  test('dry-run (no confirm) → returns preview with member_count and member_ids, no mutation', async () => {
    const db = getDb()
    const t1 = seedThought({ content: 'cluster-dissolve-dry member 1' })
    const t2 = seedThought({ content: 'cluster-dissolve-dry member 2' })
    const t3 = seedThought({ content: 'cluster-dissolve-dry member 3' })
    const { cluster } = createClusterService({ thoughtIds: [t1, t2, t3], title: 'test cluster' })

    const result = await client.callTool({
      name: 'memory_crystallize',
      arguments: { action: 'cluster_dissolve', cluster_id: cluster.id }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.status).toBe('preview')
    expect(data.cluster_id).toBe(cluster.id)
    expect(data.member_count).toBe(3)
    expect(data.member_ids).toContain(t1)
    expect(data.member_ids).toContain(t2)
    expect(data.member_ids).toContain(t3)
    expect(data.consequence).toContain('3 member edges')

    // Verify no mutation
    const clusterThought = getThoughtRow(db, cluster.id)
    expect(clusterThought).toBeTruthy()
    const edges = db.prepare('SELECT * FROM edges WHERE source_id = ? AND type = ?').all(cluster.id, 'cluster')
    expect(edges.length).toBe(3)
  })

  test('confirm:true → dissolves cluster, members become standalone', async () => {
    const db = getDb()
    const t1 = seedThought({ content: 'cluster-dissolve-confirm member 1' })
    const t2 = seedThought({ content: 'cluster-dissolve-confirm member 2' })
    const { cluster } = createClusterService({ thoughtIds: [t1, t2], title: 'test cluster' })

    const result = await client.callTool({
      name: 'memory_crystallize',
      arguments: { action: 'cluster_dissolve', cluster_id: cluster.id, confirm: true }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.status).toBe('dissolved')
    expect(data.cluster_id).toBe(cluster.id)
    expect(data.deleted_edge_count).toBe(2)
    expect(data.deleted_member_count).toBe(0)

    // Verify cluster thought is gone
    const clusterThought = getThoughtRow(db, cluster.id)
    expect(clusterThought).toBeFalsy()

    // Verify all cluster edges are gone
    const edges = db.prepare('SELECT * FROM edges WHERE source_id = ? AND type = ?').all(cluster.id, 'cluster')
    expect(edges.length).toBe(0)

    // Verify member thoughts still exist
    const member1 = getThoughtRow(db, t1)
    const member2 = getThoughtRow(db, t2)
    expect(member1).toBeTruthy()
    expect(member2).toBeTruthy()
  })

  test('dissolve non-existent cluster → error', async () => {
    const result = await client.callTool({
      name: 'memory_crystallize',
      arguments: { action: 'cluster_dissolve', cluster_id: 'non-existent' }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text).toContain('not found')
  })

  test('clusters are created unprotected → dissolve reachable without manual unprotect', async () => {
    const t1 = seedThought({ content: 'cluster-dissolve-unprotected member' })
    const { cluster } = createClusterService({ thoughtIds: [t1], title: 'unprotected cluster' })

    // createClusterService now sets is_protected: false (ADR §4) — dissolve
    // must succeed with no manual unprotect step.
    const result = await client.callTool({
      name: 'memory_crystallize',
      arguments: { action: 'cluster_dissolve', cluster_id: cluster.id, confirm: true }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.status).toBe('dissolved')
  })

  test('explicitly protected cluster → dissolve refused', async () => {
    const t1 = seedThought({ content: 'cluster-dissolve-explicit-protected member' })
    const { cluster } = createClusterService({ thoughtIds: [t1], title: 'explicitly protected cluster' })

    // Explicit protection sticks (ADR §4): protect via the MCP update surface
    const update = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'update', thought_id: cluster.id, is_protected: true }
    })
    const { isError: updateError } = parseResult(update)
    expect(updateError).toBe(false)

    const result = await client.callTool({
      name: 'memory_crystallize',
      arguments: { action: 'cluster_dissolve', cluster_id: cluster.id, confirm: true }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text).toContain('protected')
  })

  test('e2e: create cluster via MCP → dissolve via MCP → members survive', async () => {
    const db = getDb()

    // 1. Member thoughts created through the MCP surface
    const create1 = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'e2e-dissolve member 1' }
    })
    const { data: d1, isError: e1 } = parseResult(create1)
    expect(e1).toBe(false)
    const create2 = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'e2e-dissolve member 2' }
    })
    const { data: d2, isError: e2 } = parseResult(create2)
    expect(e2).toBe(false)

    // 2. Cluster created through the MCP surface (no raw SQL)
    const clusterResult = await client.callTool({
      name: 'memory_crystallize',
      arguments: { action: 'cluster', thought_ids: [d1.id, d2.id], title: 'e2e dissolve cluster' }
    })
    const { data: clusterData, isError: clusterError } = parseResult(clusterResult)
    expect(clusterError).toBe(false)
    const clusterId = clusterData.cluster.id

    // 3. Dry-run dissolve previews both members, no mutation
    const preview = await client.callTool({
      name: 'memory_crystallize',
      arguments: { action: 'cluster_dissolve', cluster_id: clusterId }
    })
    const { data: previewData, isError: previewError } = parseResult(preview)
    expect(previewError).toBe(false)
    expect(previewData.status).toBe('preview')
    expect(previewData.member_count).toBe(2)
    expect(previewData.member_ids).toContain(d1.id)
    expect(previewData.member_ids).toContain(d2.id)

    // 4. Confirm dissolve through the MCP surface
    const result = await client.callTool({
      name: 'memory_crystallize',
      arguments: { action: 'cluster_dissolve', cluster_id: clusterId, confirm: true }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.status).toBe('dissolved')
    expect(data.deleted_edge_count).toBe(2)

    // Cluster thought is gone; members survive; no cluster edges remain
    expect(getThoughtRow(db, clusterId)).toBeFalsy()
    expect(getThoughtRow(db, d1.id)).toBeTruthy()
    expect(getThoughtRow(db, d2.id)).toBeTruthy()
    const edges = db.prepare('SELECT * FROM edges WHERE source_id = ? AND type = ?').all(clusterId, 'cluster')
    expect(edges.length).toBe(0)
  })

  test('missing cluster_id → error envelope', async () => {
    const result = await client.callTool({
      name: 'memory_crystallize',
      arguments: { action: 'cluster_dissolve' }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text).toContain('cluster_id is required')
  })

  test('dissolve empty cluster → success with 0 members', async () => {
    const db = getDb()
    // Create a cluster with no members by creating one and removing all members
    const t1 = seedThought({ content: 'cluster-dissolve-empty member' })
    const { cluster } = createClusterService({ thoughtIds: [t1], title: 'empty cluster' })

    // Remove the only member
    await client.callTool({
      name: 'memory_crystallize',
      arguments: { action: 'cluster_remove', cluster_id: cluster.id, thought_id: t1, confirm: true }
    })

    // Now dissolve
    const result = await client.callTool({
      name: 'memory_crystallize',
      arguments: { action: 'cluster_dissolve', cluster_id: cluster.id, confirm: true }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.status).toBe('dissolved')
    expect(data.deleted_edge_count).toBe(0)
  })
})
