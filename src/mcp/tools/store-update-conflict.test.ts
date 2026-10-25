import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { closeDb } from '../../db/init'
import { getThoughtByIdService } from '../../services/thoughts.service'
import { createThoughtWithUrlLinksService } from '../../services/url_links.service'
import { createTestDb } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

// `memory_store` action=update shares the v046 content-dedupe guard with the
// HTTP PUT route (#2174 review finding); the MCP surface must report the same
// 409 class in its error envelope instead of a message-only failure.

interface ToolErrorEnvelope {
  content: Array<{ type: string; text: string }>
  structuredContent?: { result?: { error?: { message: string; statusCode?: number; retryable?: boolean } } }
  isError?: boolean
}

let client: Client

beforeEach(createTestDb)
afterEach(closeDb)

beforeAll(async () => {
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerAllMemoryTools(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: 'test-client', version: '0.0.0' })
  await client.connect(clientTransport)
})

async function updateThought(thoughtId: string, content: string): Promise<ToolErrorEnvelope> {
  return (await client.callTool({
    name: 'memory_store',
    arguments: { action: 'update', thought_id: thoughtId, content },
  })) as unknown as ToolErrorEnvelope
}

test('memory_store update onto live content returns a 409 envelope on every attempt', async () => {
  const holder = createThoughtWithUrlLinksService({ content: 'content already in use' })
  const target = createThoughtWithUrlLinksService({ content: 'my own content' })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await updateThought(target.id, 'content already in use')
    expect(result.isError).toBe(true)
    expect(result.structuredContent?.result?.error?.statusCode).toBe(409)
    expect(result.structuredContent?.result?.error?.message).toContain(holder.id)
    // The actionable message is the human-readable part too.
    expect(result.content[0]?.text).toContain(holder.id)
  }

  expect(getThoughtByIdService(target.id)?.content).toBe('my own content')
  expect(getThoughtByIdService(holder.id)?.content).toBe('content already in use')
})

test('memory_store update to unique content and to archived still succeed', async () => {
  const thought = createThoughtWithUrlLinksService({ content: 'ordinary content' })

  const edited = await updateThought(thought.id, 'rewritten content')
  // Success envelopes carry no `isError` at all (the SDK leaves it undefined).
  expect(edited.isError).toBeFalsy()
  expect(getThoughtByIdService(thought.id)?.content).toBe('rewritten content')

  const archived = (await client.callTool({
    name: 'memory_store',
    arguments: { action: 'update', thought_id: thought.id, status: 'archived' },
  })) as unknown as ToolErrorEnvelope
  expect(archived.isError).toBeFalsy()
  expect(getThoughtByIdService(thought.id)?.status).toBe('archived')
})
