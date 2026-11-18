import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { registerAllMemoryTools } from './index'

const EXPECTED_TOOLS = [
  'edge_review',
  'memory_crystallize',
  'memory_guide',
  'memory_manage',
  'memory_primers',
  'memory_recall',
  'memory_reflect',
  'memory_status',
  'memory_store',
  'memory_supersede',
  'retention_review'
]

async function listToolNames(): Promise<string[]> {
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerAllMemoryTools(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await client.connect(clientTransport)
  const { tools } = await client.listTools()
  return tools.map(tool => tool.name).sort()
}

test('the barrel registers every advertised memory tool exactly once', async () => {
  expect(await listToolNames()).toEqual([...EXPECTED_TOOLS].sort())
})
