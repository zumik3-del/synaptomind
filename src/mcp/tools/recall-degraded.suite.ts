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

// A fresh test DB registers no project for this path: the answer keeps the
// global scope while satisfying the hard-cwd contract.
const UNSCOPED_CWD = '/tmp/mcp-unscoped'

beforeEach(async () => { createTestDb(); client = await setupClient() })
afterEach(() => { closeDb() })

describe('recall degraded', () => {
  test('context degraded', async () => {
    await client.callTool({ name: 'memory_store', arguments: { action: 'create', content: 'degraded context marker mcp', status: 'active' } })
    const r = await client.callTool({ name: 'memory_recall', arguments: { action: 'context', query: 'degraded context marker mcp', cwd: UNSCOPED_CWD } })
    const { data, isError } = parseResult(r)
    expect(isError).toBe(false)
    expect(data.meta.degraded).toBe(true)
    expect(data.signals).toBeUndefined()
  })
  test('context degraded (no matches) surfaces degraded instead of 404', async () => {
    const r = await client.callTool({ name: 'memory_recall', arguments: { action: 'context', query: 'zzzznomatchtoken-degraded', cwd: UNSCOPED_CWD } })
    const { data, isError } = parseResult(r)
    expect(isError).toBe(false)
    expect(data.meta.degraded).toBe(true)
    expect(data.meta.reason).toBe('no_match')
    expect(data.item).toBeNull()
    expect(data.signals).toBeUndefined()
  })
  test('search degraded', async () => {
    await client.callTool({ name: 'memory_store', arguments: { action: 'create', content: 'degraded search marker mcp', status: 'active' } })
    const r = await client.callTool({ name: 'memory_recall', arguments: { action: 'search', query: 'degraded search marker mcp', cwd: UNSCOPED_CWD } })
    const { data, isError } = parseResult(r)
    expect(isError).toBe(false)
    expect(Array.isArray(data.items)).toBe(true)
    expect(data.items.length).toBeGreaterThan(0)
    expect(data.meta.degraded).toBe(true)
    expect(data.meta.action).toBe('search')
    expect(data.items[0].signals).toBeUndefined()
    expect('signals' in data.items[0]).toBe(false)
  })
})