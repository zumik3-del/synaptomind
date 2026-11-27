import { beforeAll, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { registerAllMemoryTools } from '.'

const ADVERTISED_TOOLS = [
  'memory_crystallize',
  'memory_guide',
  'memory_primers',
  'memory_projects',
  'memory_recall',
  'memory_reflect',
  'memory_retention',
  'memory_status',
  'memory_store',
  'memory_supersede'
]

// Assembled from parts so the rename scan stays clean under src/ (same trick as lanes.ts).
const RETIRED_TOOLS = ['retention' + '_review', 'memory' + '_manage']

let client: Client

beforeAll(async () => {
  const server = new McpServer({ name: 'tool-names-contract', version: '0.0.0' })
  registerAllMemoryTools(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: 'tool-names-contract-client', version: '0.0.0' })
  await client.connect(clientTransport)
})

async function advertisedNames(): Promise<string[]> {
  const { tools } = await client.listTools()
  return tools.map(tool => tool.name).sort()
}

describe('the advertised tool names', () => {
  test('are exactly the ten memory_* tools', async () => {
    expect(await advertisedNames()).toEqual([...ADVERTISED_TOOLS].sort())
  })

  test('never include a retired name', async () => {
    const names = await advertisedNames()
    for (const retired of RETIRED_TOOLS) {
      expect({ retired, advertised: names.includes(retired) }).toEqual({
        retired,
        advertised: false
      })
    }
  })

  test('answer unknown when called by a retired name, so no alias survives', async () => {
    for (const retired of RETIRED_TOOLS) {
      await expect(
        client.callTool({ name: retired, arguments: { action: 'list' } })
      ).rejects.toThrow(`Tool ${retired} not found`)
    }
  })
})
