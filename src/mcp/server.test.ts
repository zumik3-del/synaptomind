import { afterEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from './server'

const expectedTools = [
  'memory_crystallize',
  'memory_guide',
  'memory_manage',
  'memory_recall',
  'memory_reflect',
  'memory_status',
  'memory_store',
  'memory_supersede',
  'memory_telemetry'
]

let client: Client | undefined

afterEach(async () => {
  await client?.close()
  client = undefined
})

describe('MCP server discovery', () => {
  test('exposes the complete unified tool surface', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createMcpServer()
    client = new Client({ name: 'test-client', version: '0.0.0' })

    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const result = await client.listTools()
    expect(result.tools.map(tool => tool.name).sort()).toEqual(expectedTools)
  })
})
