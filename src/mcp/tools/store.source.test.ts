import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getDb } from '../../db/container'
import { closeDb } from '../../db/init'
import { createThoughtWithUrlLinks } from '../../services/thoughts.service'
import { createTestDb } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

// Coverage for task #170 finding F15: the MCP store path must stamp
// source='mcp' on created thoughts. Before the fix db/thoughts.ts carried a
// dead `source === 'mcp'` branch that nothing ever populated, so
// graph.service's agent category was unreachable from the MCP surface.

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

function parseResult(result: unknown): { data: any; isError: boolean } {
  const r = result as { content: Array<{ type: string; text: string }>; isError?: boolean }
  const text = r.content?.[0]?.text ?? '{}'
  try {
    return { data: JSON.parse(text), isError: r.isError === true }
  } catch {
    return { data: text, isError: r.isError === true }
  }
}

function dbSource(id: string): string | null {
  const row = getDb().prepare('SELECT source FROM thoughts WHERE id = ?').get(id) as { source: string | null } | undefined
  return row?.source ?? null
}

beforeEach(createTestDb)
afterEach(closeDb)

beforeAll(async () => {
  client = await setupClient()
})

describe('memory_store create stamps source=mcp (F15)', () => {
  test('a thought created through the MCP tool persists source=mcp', async () => {
    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'mcp source marker' }
    })
    const { data, isError } = parseResult(result)

    expect(isError).toBe(false)
    expect(data.id).toBeString()
    expect(dbSource(data.id)).toBe('mcp')
  })

  test('negative control: the service itself does not default to mcp', () => {
    // The source is added by the MCP tool layer, not by the shared service;
    // otherwise every HTTP-created thought would also be stamped as agent-made.
    const thought = createThoughtWithUrlLinks({ content: 'direct service marker' })
    expect(dbSource(thought.id)).toBeNull()
  })
})
