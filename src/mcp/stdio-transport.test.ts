import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

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

test('secure tunnel launcher exposes all tools over clean stdio', async () => {
  const transport = new StdioClientTransport({
    command: `${import.meta.dir}/../../scripts/run-secure-tunnel-stdio.sh`,
    env: {
      ...process.env,
      SYNAPTOMIND_BUN_BIN: process.execPath,
      SYNAPTOMIND_DB_PATH: ':memory:',
      SYNAPTOMIND_EMBEDDER_ENABLED: 'false'
    },
    stderr: 'pipe'
  })
  const client = new Client({ name: 'stdio-test', version: '0.0.0' })

  try {
    await client.connect(transport)
    const tools = (await client.listTools()).tools.map(tool => tool.name).sort()

    expect(tools).toEqual(expectedTools)
    expect(client.getInstructions()).toContain('complete unified MCP tool surface')
  } finally {
    await client.close()
  }
})
