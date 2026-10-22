import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getDb } from '../../db/container'
import { closeDb } from '../../db/init'
import { createTestDb, seedThought } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

mock.module('../../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: () => [new Float32Array(384)],
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

let client: Client
async function setup() {
  const s = new McpServer({ name: 't', version: '0' })
  registerAllMemoryTools(s)
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await s.connect(st)
  const c = new Client({ name: 'c', version: '0' })
  await c.connect(ct)
  return c
}
function parse(r: any) { const t = r.content?.[0]?.text ?? '{}'; try { return JSON.parse(t) } catch { return t } }

beforeEach(createTestDb)
afterEach(closeDb)
beforeAll(async () => { client = await setup() })

test('repro bm25 search output', async () => {
  await client.callTool({ name: 'memory_store', arguments: { action: 'create', content: 'BM25UNIQUEKEYWORD marker content here', status: 'active' } })
  const r = await client.callTool({ name: 'memory_recall', arguments: { action: 'search', query: 'BM25UNIQUEKEYWORD', top_k: 10 } })
  const data = parse(r)
  console.log('OUTPUT:', JSON.stringify(data, null, 2))
})
