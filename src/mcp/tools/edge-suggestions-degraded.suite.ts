import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { closeDb } from '../../db/init'
import { createTestDb } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

/**
 * Degraded-branch contract for #927/#932: when the embedder is unavailable,
 * memory_status action=edge_suggestions returns degraded:true with no proposals.
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

describe('memory_status edge_suggestions degraded branch', () => {
  test('degraded:true with empty proposals when embedder throws', async () => {
    for (let i = 0; i < 3; i++) {
      await client.callTool({
        name: 'memory_store',
        arguments: { action: 'create', content: `degraded-${i}`, status: 'active' }
      })
    }

    const result = await client.callTool({
      name: 'memory_status',
      arguments: { action: 'edge_suggestions' }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.degraded).toBe(true)
    expect(data.proposals).toEqual([])
    expect(typeof data.candidates).toBe('number')
    expect(data.candidates).toBeGreaterThan(0)
  })
})
