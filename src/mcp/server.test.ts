import { beforeAll, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { createTestDb } from '../test/helpers'
import { createMcpServer } from './server'

const EXPECTED_TOOLS = [
  'memory_recall',
  'memory_store',
  'memory_supersede',
  'memory_status',
  'memory_manage',
  'memory_crystallize',
  'memory_reflect',
  'memory_primers',
  'edge_review',
  'retention_review',
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

  test('listTools exposes exactly the eleven action tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort())
  })

  test('prompts/list returns an empty list because no prompts capability is advertised', async () => {
    const { prompts } = await client.listPrompts()
    expect(prompts).toEqual([])
  })

  test('resources/list returns an empty list because no resources capability is advertised', async () => {
    const { resources } = await client.listResources()
    expect(resources).toEqual([])
  })
})
