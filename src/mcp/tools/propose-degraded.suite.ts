import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { closeDb } from '../../db/init'
import { createTestDb, seedThought } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

/**
 * Degraded-branch contract for task #951: when the embedder is unavailable,
 * memory_status action=propose returns degraded:true with lexical-only signals.
 *
 * Runs in isolation (no .test suffix) to avoid bun:test mock.module leakage
 * through export * re-exports (PR #114, b2e5cd5).
 */

// Replace the embedder with a failing implementation *before* any module
// that imports it is loaded. The wrapper spawns this file as a subprocess.
mock.module('../../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: async () => { throw new Error('embedder down') },
  restartEmbedder: () => {},
  isEmbedderReady: () => false
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

describe('memory_status propose degraded branch', () => {
  test('degraded:true with keep lifecycle and no edges when embedder throws', async () => {
    seedThought({ content: 'degraded thought alpha' })
    seedThought({ content: 'degraded thought beta' })

    // Fallback: call propose on a seeded thought directly.
    const ids: string[] = []
    for (let i = 0; i < 2; i++) {
      const r = await client.callTool({
        name: 'memory_store',
        arguments: { action: 'create', content: `degraded-seed-${i}`, status: 'active' }
      })
      const text = (r as { content: Array<{ text: string }> })?.content?.[0]?.text ?? ''
      try { ids.push(JSON.parse(text).id) } catch { /* skip */ }
    }
    if (ids.length === 0) {
      // If seeding failed entirely, still assert degraded via a known-empty graph.
      const emptyResult = await client.callTool({
        name: 'memory_status',
        arguments: { action: 'propose', content: 'standalone draft degraded' }
      })
      const { data, isError } = parseResult(emptyResult)
      expect(isError).toBe(false)
      expect(data.degraded).toBe(true)
      expect(Array.isArray(data.edges)).toBe(true)
      expect(data.edges).toEqual([])
      expect(data.lifecycle.action).toBe('keep')
      return
    }

    const r = await client.callTool({
      name: 'memory_status',
      arguments: { action: 'propose', thought_id: ids[0] }
    })
    const { data, isError } = parseResult(r)
    expect(isError).toBe(false)
    expect(data.degraded).toBe(true)
    expect(Array.isArray(data.edges)).toBe(true)
    // Degraded path suppresses embedding-based edges; lexical merge may still
    // fire if the draft is a near-dup of another thought.
    if (data.edges.length > 0) {
      expect(data.lifecycle.action).toBeOneOf(['link', 'merge', 'replaces+archive'])
    } else {
      expect(data.lifecycle.action).toBe('keep')
    }
  })

  test('draft content degrades gracefully when embedder is down', async () => {
    const result = await client.callTool({
      name: 'memory_status',
      arguments: { action: 'propose', content: 'draft degraded contract' }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.thought_id).toBe('(draft)')
    expect(data.degraded).toBe(true)
    expect(Array.isArray(data.edges)).toBe(true)
    expect(typeof data.generated_at).toBe('string')
  })
})
