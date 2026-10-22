import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { closeDb } from '../../db/init'
import { getSlots } from '../../services/slots.service'
import { createTestDb } from '../../test/helpers'
import { registerMemoryReflect } from './reflect'

let client: Client

async function setupClient(): Promise<Client> {
  const server = new McpServer({ name: 'reflect-contract-test', version: '0.0.0' })
  registerMemoryReflect(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const testClient = new Client({ name: 'reflect-contract-client', version: '0.0.0' })
  await testClient.connect(clientTransport)
  return testClient
}

function parseResult(result: unknown): { data: any; isError: boolean } {
  const response = result as { content: Array<{ text: string }>; isError?: boolean }
  const text = response.content?.[0]?.text ?? '{}'
  try {
    return { data: JSON.parse(text), isError: response.isError === true }
  } catch {
    return { data: text, isError: response.isError === true }
  }
}

beforeEach(async () => {
  createTestDb()
  client = await setupClient()
})
afterEach(async () => {
  await client?.close()
  closeDb()
})

test('MCP reflect adds goals with case-insensitive exact dedupe', async () => {
  const result = parseResult(await client.callTool({
    name: 'memory_reflect',
    arguments: { action: 'reflect', goals_add: ['Ship alpha', 'ship ALPHA', 'Ship beta'] }
  }))
  expect(result.isError).toBe(false)
  expect(result.data.goals_added).toBe(2)
  expect(getSlots({ names: ['active_goals'] })[0].content).toBe('Ship alpha\nShip beta')
})

test('MCP reflect rejects blank goals', async () => {
  const result = parseResult(await client.callTool({
    name: 'memory_reflect',
    arguments: { action: 'reflect', goals_add: ['  '] }
  }))
  expect(result.isError).toBe(true)
})

test('MCP reflect removes stored goals by case-insensitive substring and keeps same-call additions', async () => {
  await client.callTool({ name: 'memory_reflect', arguments: { action: 'reflect', goals_add: ['Ship alpha', 'Ship beta'] } })
  const result = parseResult(await client.callTool({
    name: 'memory_reflect',
    arguments: { action: 'reflect', goals_add: ['Ship gamma'], goals_remove: ['ALPHA', 'BETA'] }
  }))
  expect(result.isError).toBe(false)
  expect(result.data.goals_removed).toBe(2)
  expect(getSlots({ names: ['active_goals'] })[0].content).toBe('Ship gamma')
})

test('MCP reflect rejects retired goals_delta with migration hint', async () => {
  const result = parseResult(await client.callTool({
    name: 'memory_reflect',
    arguments: { action: 'reflect', goals_delta: ['old goal'] }
  }))
  expect(result.isError).toBe(true)
  expect(String(result.data)).toContain('goals_add / goals_remove')
})
