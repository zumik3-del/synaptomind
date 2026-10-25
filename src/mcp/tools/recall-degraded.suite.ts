import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { closeDb } from '../../db/init'
import { createTestDb } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

mock.module('../../embedder/client', () => ({
  generateEmbedding: async () => { throw new Error('embedder down') },
  generateEmbeddings: async () => { throw new Error('embedder down') },
  restartEmbedder: () => {},
  isEmbedderReady: () => false
}))

let client: Client
async function setupClient() {
  const s = new SdkMcpServer({ name: 'test', version: '0.0.0' })
  registerAllMemoryTools(s)
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await s.connect(st)
  const c = new Client({ name: 'test-client', version: '0.0.0' })
  await c.connect(ct)
  return c
}
function parseResult(r: unknown) {
  const rr = r as { content: Array<{ text: string }>; isError?: boolean }
  const text = rr.content?.[0]?.text ?? '{}'
  try { return { data: JSON.parse(text), isError: rr.isError === true } } catch { return { data: text, isError: rr.isError === true } }
}

beforeEach(async () => { createTestDb(); client = await setupClient() })
afterEach(() => { closeDb() })

describe('recall degraded', () => {
  test('context degraded', async () => {
    await client.callTool({ name: 'memory_store', arguments: { action: 'create', content: 'degraded context marker mcp', status: 'active' } })
    const r = await client.callTool({ name: 'memory_recall', arguments: { action: 'context', query: 'degraded context marker mcp' } })
    const { data, isError } = parseResult(r)
    console.log('CONTEXT DATA:', JSON.stringify(data))
    expect(isError).toBe(false)
    expect(data.degraded).toBe(true)
    expect(data.signals).toBeUndefined()
  })
  test('context degraded (no matches) surfaces degraded instead of 404', async () => {
    const r = await client.callTool({ name: 'memory_recall', arguments: { action: 'context', query: 'zzzznomatchtoken-degraded' } })
    const { data, isError } = parseResult(r)
    console.log('CONTEXT DEGRADED-ONLY:', JSON.stringify(data))
    expect(isError).toBe(false)
    expect(data.degraded).toBe(true)
    expect(data.best_match).toBeUndefined()
    expect(data.signals).toBeUndefined()
  })
  test('search degraded', async () => {
    await client.callTool({ name: 'memory_store', arguments: { action: 'create', content: 'degraded search marker mcp', status: 'active' } })
    const r = await client.callTool({ name: 'memory_recall', arguments: { action: 'search', query: 'degraded search marker mcp' } })
    const { data, isError } = parseResult(r)
    console.log('SEARCH DATA:', JSON.stringify(data))
    expect(isError).toBe(false)
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThan(0)
    expect(data[0].degraded).toBe(true)
    expect(data[0].signals).toBeUndefined()
    expect('signals' in data[0]).toBe(false)
  })
})