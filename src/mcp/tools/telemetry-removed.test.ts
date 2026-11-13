import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { closeDb } from '../../db/init'
import { createTestDb } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

let client: Client

async function setupClient(): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerAllMemoryTools(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const c = new Client({ name: 'test-client', version: '0.0.0' })
  await c.connect(clientTransport)
  return c
}

beforeEach(async () => {
  createTestDb()
  client = await setupClient()
})

afterEach(closeDb)

describe('the removed memory_telemetry tool', () => {
  test('the advertised tool list no longer contains memory_telemetry', async () => {
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)

    expect(names).not.toContain('memory_telemetry')
    expect(names).toContain('memory_primers')
    expect(tools.length).toBe(11)
  })

  test('calling memory_telemetry answers with the SDK unknown-tool error', async () => {
    await expect(
      client.callTool({ name: 'memory_telemetry', arguments: { action: 'query' } })
    ).rejects.toThrow(/memory_telemetry/i)
  })

  test('the in-band guide advertises memory_primers and not memory_telemetry', async () => {
    const guide = await client.callTool({ name: 'memory_guide', arguments: {} })
    const text = (guide as { content: Array<{ text: string }> }).content[0].text

    expect(text).toContain('memory_primers')
    expect(text).not.toContain('memory_telemetry')
  })
})
