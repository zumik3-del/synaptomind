import { beforeAll, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { createTestDb } from '../test/helpers'
import { createMcpServer } from './server'

// Coverage for task #170 finding F12: the MCP surface is intentionally
// tools-only. This locks the decision down so a future change that registers
// resources/prompts — and therefore a new capability on the wire — fails here.

const EXPECTED_TOOLS = [
  'memory_recall',
  'memory_store',
  'memory_supersede',
  'memory_status',
  'memory_manage',
  'memory_crystallize',
  'memory_reflect',
  'memory_telemetry',
  'memory_guide'
]

let client: Client

beforeAll(async () => {
  createTestDb()
  const server = createMcpServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: 'surface-test-client', version: '0.0.0' })
  await client.connect(clientTransport)
})

describe('MCP surface is tools-only (F12)', () => {
  test('advertises the tools capability and neither resources nor prompts', () => {
    const caps = client.getServerCapabilities()

    expect(caps?.tools).toBeDefined()
    expect(caps?.resources).toBeUndefined()
    expect(caps?.prompts).toBeUndefined()
  })

  test('listTools exposes exactly the nine action tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort())
  })

  test('prompts/list is refused because no prompts capability is advertised', async () => {
    // The SDK answers -32601 (method not found) when no handler is registered.
    await expect(client.listPrompts()).rejects.toThrow(/-32601|method not found/i)
  })

  test('resources/list is refused because no resources capability is advertised', async () => {
    await expect(client.listResources()).rejects.toThrow(/-32601|method not found/i)
  })
})
