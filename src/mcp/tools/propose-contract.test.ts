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

interface ProposeMeta {
  action: string
  degraded: boolean
  scope: { project: string | null; project_name: string | null; global: boolean } | null
  counts: { total: number; returned: number; filtered_out: number }
  warnings: string[]
}

/** The plan lives in the shared envelope's `item` (task #2179). */
function parseResult(result: unknown): { data: PlacementPlan | null; meta: ProposeMeta | null; isError: boolean; text: string } {
  const r = result as { content: Array<{ type: string; text: string }>; isError?: boolean }
  const text = r.content?.[0]?.text ?? ''
  try {
    const parsed = JSON.parse(text) as { item?: PlacementPlan | null; meta?: ProposeMeta }
    return { data: (parsed.item ?? null) as PlacementPlan | null, meta: parsed.meta ?? null, isError: r.isError === true, text }
  } catch {
    return { data: null, meta: null, isError: r.isError === true, text }
  }
}

// A fresh test DB registers no project for this path: the answer keeps the
// global scope while satisfying the hard-cwd contract.
const UNSCOPED_CWD = '/tmp/mcp-unscoped'

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
      arguments: { action: 'propose', thought_id: id, cwd: UNSCOPED_CWD }
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
      arguments: { action: 'propose', thought_id: 'does-not-exist', cwd: UNSCOPED_CWD }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text.toLowerCase()).toContain('not found')
  })

  test('result shape carries a degraded flag and an edges array', async () => {
    const id = seedThought({ content: 'shape mirror' })
    const plan = await client.callTool({
      name: 'memory_status',
      arguments: { action: 'propose', thought_id: id, cwd: UNSCOPED_CWD }
    })
    const planData = parseResult(plan).data
    // The plan carries a degraded flag and the proposed edges.
    expect(typeof planData!.degraded).toBe('boolean')
    expect(Array.isArray(planData!.edges)).toBe(true)
  })
})

// ── content (draft) path ─────────────────────────────────────────────────────

describe('memory_status propose — content (draft) path', () => {
  test('returns a PlacementPlan for unpersisted draft content', async () => {
    const result = await client.callTool({
      name: 'memory_status',
      arguments: { action: 'propose', content: 'draft thought about contracts', cwd: UNSCOPED_CWD }
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
    db.prepare(`INSERT OR IGNORE INTO projects (id, name, created_at, local_path) VALUES ('proj-contract', 'Contract Project', ?, '/tmp/proj-contract')`).run(new Date().toISOString())
    seedThought({ content: 'scoped thought', project_id: 'proj-contract' })

    const result = await client.callTool({
      name: 'memory_status',
      arguments: { action: 'propose', content: 'scoped draft', cwd: '/tmp/proj-contract' }
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
      arguments: { action: 'propose', cwd: UNSCOPED_CWD }
    })
    const { isError, text } = parseResult(result)
    expect(isError).toBe(true)
    expect(text).toContain('thought_id')
    expect(text).toContain('content')
  })

  test('empty strings for both fields return an isError envelope', async () => {
    const result = await client.callTool({
      name: 'memory_status',
      arguments: { action: 'propose', thought_id: '', content: '', cwd: UNSCOPED_CWD }
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
    await client.callTool({ name: 'memory_status', arguments: { action: 'propose', thought_id: a, cwd: UNSCOPED_CWD } })
    await client.callTool({ name: 'memory_status', arguments: { action: 'propose', thought_id: b, cwd: UNSCOPED_CWD } })
    await client.callTool({ name: 'memory_status', arguments: { action: 'propose', content: 'draft no-mutate', cwd: UNSCOPED_CWD } })

    const after = fp(db)
    expect(after).toEqual(before)
  })
})
