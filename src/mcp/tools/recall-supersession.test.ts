import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getDb } from '../../db/container'
import { createEdge } from '../../db/edges'
import { closeDb } from '../../db/init'
import { createTestDb, seedThought } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

// Independent MCP coverage for the agent-facing supersession contract
// (ADR #142, item 3): `memory_recall` defaults to `suppress`, accepts
// off|flag|suppress, and the schema rejects unknown values. Mirrors the client
// setup of tools.test.ts / regression.test.ts.

mock.module('../../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: () => [new Float32Array(384)],
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

let client: Client

async function setupClient(): Promise<Client> {
  const s = new McpServer({ name: 'test', version: '0.0.0' })
  registerAllMemoryTools(s)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await s.connect(serverTransport)
  const c = new Client({ name: 'test-client', version: '0.0.0' })
  await c.connect(clientTransport)
  return c
}

function parseResult(result: unknown): { data: any; isError: boolean } {
  const r = result as { content: Array<{ type: string; text: string }>; isError?: boolean }
  const text = r.content?.[0]?.text ?? '{}'
  try {
    return { data: JSON.parse(text), isError: r.isError === true }
  } catch {
    return { data: text, isError: r.isError === true }
  }
}

beforeEach(createTestDb)
afterEach(closeDb)

beforeAll(async () => {
  client = await setupClient()
})

const QUERY = 'mcpstanding'

function seedSupersededPair(): { oldThought: string; newThought: string } {
  const oldThought = seedThought({ content: `${QUERY} older replaced claim` })
  const newThought = seedThought({ content: `${QUERY} newer claim` })
  createEdge(getDb(), newThought, oldThought, 'replaces')
  return { oldThought, newThought }
}

async function recallSupersession(extra: Record<string, unknown> = {}) {
  const result = await client.callTool({
    name: 'memory_recall',
    arguments: { action: 'search', query: QUERY, top_k: 10, ...extra }
  })
  return parseResult(result)
}

describe('memory_recall supersession contract', () => {
  test('defaults to suppress: superseded thought is not returned', async () => {
    const { oldThought, newThought } = seedSupersededPair()

    const { data, isError } = await recallSupersession()
    expect(isError).toBe(false)
    const ids = (data as Array<{ thought: { id: string } }>).map(r => r.thought.id)
    expect(ids).toContain(newThought)
    expect(ids).not.toContain(oldThought)
  })

  test('supersession_mode=flag returns the superseded thought annotated', async () => {
    const { oldThought, newThought } = seedSupersededPair()

    const { data, isError } = await recallSupersession({ supersession_mode: 'flag' })
    expect(isError).toBe(false)
    const old = (data as Array<{ thought: { id: string }; standing?: string; superseded_by?: string[] }>).find(
      r => r.thought.id === oldThought
    )
    expect(old).toBeDefined()
    expect(old?.standing).toBe('superseded')
    expect(old?.superseded_by).toEqual([newThought])
  })

  test('supersession_mode=off stops flagging superseded thoughts', async () => {
    const { oldThought } = seedSupersededPair()

    const { data, isError } = await recallSupersession({ supersession_mode: 'off' })
    expect(isError).toBe(false)
    const old = (data as Array<{ thought: { id: string }; standing?: string; superseded_by?: string[] }>).find(
      r => r.thought.id === oldThought
    )
    expect(old).toBeDefined()
    expect(old?.standing).not.toBe('superseded')
    expect(old?.superseded_by).toBeUndefined()
  })

  test('contradicted thoughts are flagged, not suppressed, by default', async () => {
    const a = seedThought({ content: `${QUERY} contradicted alpha` })
    const b = seedThought({ content: `${QUERY} contradicted beta` })
    createEdge(getDb(), a, b, 'contradicts')

    const { data, isError } = await recallSupersession()
    expect(isError).toBe(false)
    const results = data as Array<{ thought: { id: string }; standing?: string }>
    expect(results.find(r => r.thought.id === a)?.standing).toBe('contradicted')
    expect(results.find(r => r.thought.id === b)?.standing).toBe('contradicted')
  })

  test('rejects an invalid supersession_mode at schema level', async () => {
    const { isError } = await recallSupersession({ supersession_mode: 'bogus' })
    expect(isError).toBe(true)
  })

  test('rejects an invalid contradiction_mode at schema level', async () => {
    const { isError } = await recallSupersession({ contradiction_mode: 'suppress' })
    expect(isError).toBe(true)
  })
})
