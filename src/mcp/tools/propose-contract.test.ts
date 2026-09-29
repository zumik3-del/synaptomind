import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { closeDb, getDb } from '../../db'
import { createTestDb, seedThought } from '../../test/helpers'
import { registerAllMemoryTools } from '.'
import type { PlacementPlan } from '../../services/placement/types'

/**
 * Contract tests for #951: MCP memory_status action=propose surface.
 *
 * Covers the action-tool contract (thought_id / content paths, project/cwd
 * resolution, error envelopes) and the read-only invariant — the surface
 * must never mutate edges / status / cluster rows.
 */

mock.module('../../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: async () => [new Float32Array(384)],
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

let client: Client

async function setupClient(): Promise<Client> {
  const s = new SdkMcpServer({ name: 'test', version: '0.0.0' })
  registerAllMemoryTools(s)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await s.connect(serverTransport)
  const c = new Client({ name: 'test-client', version: '0.0.0' })
  await c.connect(clientTransport)
  return c
}

function parseResult(result: unknown): { data: PlacementPlan | null; isError: boolean; text: string } {
  const r = result as { content: Array<{ type: string; text: string }>; isError?: boolean }
  const text = r.content?.[0]?.text ?? ''
  try {
    return { data: JSON.parse(text) as PlacementPlan, isError: r.isError === true, text }
  } catch {
    return { data: null, isError: r.isError === true, text }
  }
}

beforeEach(async () => {
  createTestDb()
  client = await setupClient()
})

afterEach(() => {
  closeDb()
})

// ── thought_id path ───────────────────────────────────────────────────────────

describe('memory_status propose — thought_id path', () => {
  test('returns a PlacementPlan shape for an existing thought', async () => {
    const id = seedThought({ content: 'contract-marker existing thought' })
    const result = await client.callTool({
      name: 'memory_status',
      arguments: { action: 'propose', thought_id: id }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data).not.toBeNull()
    expect(data!.thought_id).toBe(id)
    expect(typeof data!.generated_at).toBe('string')
    expect(typeof data!.degraded).toBe('boolean')
    expect(Array.isArray(data!.edges)).toBe(true)
    expect(data!.placement).toBeNull() // no cluster match in empty DB
    expect(typeof data!.lifecycle.action).toBe('string')
    expect(['keep', 'link', 'merge', 'replaces+archive']).toContain(data!.lifecycle.action)
    expect(data!.lifecycle.review_required).toBe(true)
    expect(Array.isArray(data!.lifecycle.blocked_by)).toBe(true)
  })

  test('unknown thought_id returns an isError envelope', async () => {
    const result = await client.callTool({
      name: 'memory_status',
      arguments: { action: 'propose', thought_id: 'does-not-exist' }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text.toLowerCase()).toContain('not found')
  })

  test('result shape mirrors edge_suggestions degraded shape', async () => {
    const id = seedThought({ content: 'shape mirror' })
    const [plan, edges] = await Promise.all([
      client.callTool({ name: 'memory_status', arguments: { action: 'propose', thought_id: id } }),
      client.callTool({ name: 'memory_status', arguments: { action: 'edge_suggestions' } })
    ])
    const planData = parseResult(plan).data
    const edgesResult = parseResult(edges)
    // Both surfaces carry a degraded flag.
    expect(typeof planData!.degraded).toBe('boolean')
    expect(typeof (edgesResult.data as any)?.degraded).toBe('boolean')
    // Plan carries edges array; edge_suggestions carries proposals array.
    expect(Array.isArray(planData!.edges)).toBe(true)
    expect(Array.isArray((edgesResult.data as any)?.proposals)).toBe(true)
  })
})

// ── content (draft) path ─────────────────────────────────────────────────────

describe('memory_status propose — content (draft) path', () => {
  test('returns a PlacementPlan for unpersisted draft content', async () => {
    const result = await client.callTool({
      name: 'memory_status',
      arguments: { action: 'propose', content: 'draft thought about contracts' }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data).not.toBeNull()
    expect(data!.thought_id).toBe('(draft)')
    expect(typeof data!.generated_at).toBe('string')
    expect(typeof data!.degraded).toBe('boolean')
    expect(Array.isArray(data!.edges)).toBe(true)
    expect(data!.lifecycle.action).toBe('keep') // no merge target in empty DB
  })

  test('draft content uses cwd/project scope when provided', async () => {
    // Seed a thought in a named project so we can assert project resolution works.
    const db = getDb()
    db.prepare(`INSERT OR IGNORE INTO projects (id, name, created_at) VALUES ('proj-contract', 'Contract Project', ?)`).run(new Date().toISOString())
    seedThought({ content: 'scoped thought', project_id: 'proj-contract' })

    const result = await client.callTool({
      name: 'memory_status',
      arguments: { action: 'propose', content: 'scoped draft', project_id: 'proj-contract' }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data).not.toBeNull()
    expect(data!.thought_id).toBe('(draft)')
  })
})

// ── error envelope — missing both thought_id and content ─────────────────────

describe('memory_status propose — input validation', () => {
  test('missing both thought_id and content returns an isError envelope', async () => {
    const result = await client.callTool({
      name: 'memory_status',
      arguments: { action: 'propose' }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text).toContain('thought_id')
    expect(text).toContain('content')
  })

  test('empty strings for both fields return an isError envelope', async () => {
    const result = await client.callTool({
      name: 'memory_status',
      arguments: { action: 'propose', thought_id: '', content: '' }
    })
    const { isError } = parseResult(result)
    expect(isError).toBe(true)
  })
})

// ── read-only invariant ───────────────────────────────────────────────────────

describe('memory_status propose — read-only invariant', () => {
  function fp(db: import('bun:sqlite').Database): Record<string, number> {
    const c = (sql: string) => (db.prepare(sql).get() as { n: number }).n
    return {
      thoughts:       c('SELECT COUNT(*) AS n FROM thoughts'),
      edges:          c('SELECT COUNT(*) AS n FROM edges'),
      clusterEdges:   c("SELECT COUNT(*) AS n FROM edges WHERE type='cluster'"),
      clusterThoughts: c('SELECT COUNT(*) AS n FROM thoughts WHERE is_cluster=1'),
      archived:       c("SELECT COUNT(*) AS n FROM thoughts WHERE status='archived'"),
    }
  }

  test('propose does not mutate edges, status or cluster rows', async () => {
    const db = getDb()
    const a = seedThought({ content: 'before-a' })
    const b = seedThought({ content: 'before-b' })
    seedThought({ content: 'before-c', is_cluster: 1 })

    const before = fp(db)
    await client.callTool({ name: 'memory_status', arguments: { action: 'propose', thought_id: a } })
    await client.callTool({ name: 'memory_status', arguments: { action: 'propose', thought_id: b } })
    await client.callTool({ name: 'memory_status', arguments: { action: 'propose', content: 'draft no-mutate' } })

    const after = fp(db)
    expect(after).toEqual(before)
  })
})
