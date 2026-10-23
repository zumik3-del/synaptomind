import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { closeDb } from '../../db/init'
import { createTestDb } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

let client: Client

beforeEach(async () => {
  createTestDb()
  const server = new McpServer({ name: 'retired-input-contract', version: '0.0.0' })
  registerAllMemoryTools(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: 'retired-input-client', version: '0.0.0' })
  await client.connect(clientTransport)
})
afterEach(async () => {
  await client?.close()
  closeDb()
})

async function schema(name: string) {
  const { tools } = await client.listTools()
  return tools.find(tool => tool.name === name)?.inputSchema as {
    properties: Record<string, { type?: string; description?: string; not?: unknown }>
  }
}

async function rejected(name: string, args: Record<string, unknown>, guidance: string) {
  const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content?: Array<{ text: string }> }
  expect(result.isError).toBe(true)
  expect(result.content?.map(item => item.text).join('\n')).toContain(guidance)
}

test('advertises retired-input tombstones with actionable descriptions', async () => {
  const cases = [
    ['memory_recall', 'top_k', 'Removed; use limit.'], ['memory_recall', 'cluster', 'Removed; use is_cluster.'],
    ['memory_status', 'k', 'Removed; use limit.'],
    ['memory_review', 'max_items', 'Removed; use max_proposals.'], ['memory_crystallize', 'dry_run', 'Removed; use confirm.'],
    ['memory_reflect', 'goals_delta', 'Removed; use goals_add / goals_remove.'],
    ['memory_store', 'is_profile', 'Retired: remove this field; there is no replacement.']
  ] as const
  for (const [tool, key, description] of cases) {
    const property = (await schema(tool)).properties[key]
    expect(property.description).toBe(description)
    expect(property.not).toEqual({})
  }
})

test('store thought_id is documented as action-scoped and not globally retired', async () => {
  const property = (await schema('memory_store')).properties.thought_id
  expect(property.type).toBe('string')
  expect(property.description).toContain('REJECTED for "link"')
  expect(property.not).toBeUndefined()
})

test('rejects retired recall arguments with replacement guidance', async () => {
  await rejected('memory_recall', { action: 'search', query: 'x', top_k: 1 }, 'limit')
  await rejected('memory_recall', { action: 'list', cluster: true }, 'is_cluster')
})

test('rejects retired status, review, crystallize, reflect, and store arguments with guidance', async () => {
  await rejected('memory_status', { action: 'slots', k: 1 }, 'limit')
  await rejected('memory_review', { action: 'list', max_items: 1 }, 'max_proposals')
  await rejected('memory_crystallize', { action: 'graph', dry_run: true }, 'confirm')
  await rejected('memory_reflect', { action: 'reflect', goals_delta: ['old'] }, 'goals_add / goals_remove')
  await rejected('memory_store', { action: 'create', content: 'retired profile', is_profile: true }, 'is_profile is retired')
})

test('rejects store thought_id for link while retaining action guidance', async () => {
  await rejected('memory_store', { action: 'link', thought_id: 'old', source_id: 'a', target_id: 'b' }, 'source_id')
})
