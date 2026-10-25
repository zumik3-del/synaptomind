import { afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { closeDb } from '../../db/init'
import { createTestDb } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

mock.module('../../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: () => [new Float32Array(384)],
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

let client: Client

async function setupClient(): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerAllMemoryTools(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const result = new Client({ name: 'test-client', version: '0.0.0' })
  await result.connect(clientTransport)
  return result
}

function toolResult(result: unknown): { data: any; isError: boolean } {
  const response = result as { content: Array<{ text: string }>; isError?: boolean }
  const text = response.content?.[0]?.text ?? '{}'
  try {
    return { data: JSON.parse(text), isError: response.isError === true }
  } catch {
    return { data: text, isError: response.isError === true }
  }
}

beforeEach(createTestDb)
afterEach(closeDb)
beforeAll(async () => {
  client = await setupClient()
})

test('memory_store link rejects legacy thought_id with a source_id migration hint', async () => {
  const result = await client.callTool({
    name: 'memory_store',
    arguments: { action: 'link', thought_id: 'source', source_id: 'source', target_id: 'target' }
  })
  const { data, isError } = toolResult(result)

  expect(isError).toBe(true)
  expect(String(data)).toContain('source_id')
})

test('memory_store update continues accepting thought_id', async () => {
  const created = toolResult(await client.callTool({
    name: 'memory_store',
    arguments: { action: 'create', content: 'update compatibility marker' }
  })).data
  const updated = toolResult(await client.callTool({
    name: 'memory_store',
    arguments: { action: 'update', thought_id: created.id, content: 'updated compatibility marker' }
  }))

  expect(updated.isError).toBe(false)
  expect(updated.data.content).toBe('updated compatibility marker')
})

test('memory_status frontier accepts limit 1 and rejects 51 with its range', async () => {
  const minimum = toolResult(await client.callTool({
    name: 'memory_status', arguments: { action: 'frontier', limit: 1, cwd: '/tmp/mcp-unscoped' }
  }))
  expect(minimum.isError).toBe(false)

  const over = toolResult(await client.callTool({
    name: 'memory_status', arguments: { action: 'frontier', limit: 51, cwd: '/tmp/mcp-unscoped' }
  }))
  expect(over.isError).toBe(true)
  expect(String(over.data)).toContain('50')
})

test('memory_status slots accepts a limit above the frontier maximum', async () => {
  const result = toolResult(await client.callTool({
    name: 'memory_status', arguments: { action: 'slots', slots_limit: 51, cwd: '/tmp/mcp-unscoped' }
  }))

  expect(result.isError).toBe(false)
})
