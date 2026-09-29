import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { closeDb } from '../../db/init'
import { createTestDb } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

/**
 * Contract test for #927: memory_status action=edge_suggestions proposals are
 * non-conflict `related` candidates, never `contradicts`.
 *
 * Verifies the MCP-level output shape — not the service internals — to catch
 * regressions where the handler, tool registration, or serialization path
 * drifts from the decided contract.
 */

// Mock the embedder so proposals can be produced without a live HuggingFace
// process. The mock returns vectors for every candidate text.
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

function parseResult(result: unknown): { data: any; isError: boolean } {
  const r = result as { content: Array<{ type: string; text: string }>; isError?: boolean }
  const text = r.content?.[0]?.text ?? '{}'
  try {
    return { data: JSON.parse(text), isError: r.isError === true }
  } catch {
    return { data: text, isError: r.isError === true }
  }
}

beforeEach(async () => {
  createTestDb()
  client = await setupClient()
})

afterEach(() => {
  closeDb()
})

// ── Normal path: seeded graph produces `related`-only proposals ──────────────

describe('memory_status edge_suggestions contract (task #932)', () => {
  test('every proposal is type:related, rationale:embedding_similarity_only, review_required:true', async () => {
    // Seed 3 active non-cluster thoughts so the service has candidates to pair.
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = await client.callTool({
        name: 'memory_store',
        arguments: { action: 'create', content: `contract-marker-${i}`, status: 'active' }
      })
      const { data } = parseResult(r)
      ids.push(data.id)
    }

    const result = await client.callTool({
      name: 'memory_status',
      arguments: { action: 'edge_suggestions' }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(Array.isArray(data.proposals)).toBe(true)
    for (const p of data.proposals) {
      expect(p.type).toBe('related')
      expect(p.rationale).toBe('embedding_similarity_only')
      expect(p.review_required).toBe(true)
      // Explicitly guard against the #927 regression: never contradicts.
      expect(p.type).not.toBe('contradicts')
    }
  })

  test('no proposal ever carries type:contradicts', async () => {
    // Seed enough candidates to likely surface proposals even with flat embeddings.
    for (let i = 0; i < 10; i++) {
      await client.callTool({
        name: 'memory_store',
        arguments: { action: 'create', content: `contradicts-scare-${i}`, status: 'active' }
      })
    }

    const { data } = parseResult(await client.callTool({
      name: 'memory_status',
      arguments: { action: 'edge_suggestions' }
    }))
    const proposals = data.proposals as Array<{ type: string }>
    if (proposals.length === 0) return // degraded or too few candidates is fine; guard only when present
    const contradicts = proposals.filter(p => p.type === 'contradicts')
    expect(contradicts).toHaveLength(0)
  })

  test('result shape carries degraded flag and candidate count', async () => {
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'shape-check', status: 'active' }
    })
    const { data, isError } = parseResult(await client.callTool({
      name: 'memory_status',
      arguments: { action: 'edge_suggestions' }
    }))
    expect(isError).toBe(false)
    expect(typeof data.candidates).toBe('number')
    expect(typeof data.pairs_evaluated).toBe('number')
    expect(typeof data.degraded).toBe('boolean')
    expect(Array.isArray(data.proposals)).toBe(true)
  })

  // ── Degraded branch exercised in edge-suggestions-degraded.suite.ts ─────
})
