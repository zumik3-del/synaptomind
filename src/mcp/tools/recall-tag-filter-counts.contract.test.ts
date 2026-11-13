import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { closeDb } from '../../db/init'
import { createTestDb, isVecExtensionAvailable, seedThought, withVecDb } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

mock.module('../../embedder/client', () => ({
  generateEmbedding: async () => new Float32Array(384),
  generateEmbeddings: async () => [new Float32Array(384)],
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

const UNSCOPED_CWD = '/tmp/mcp-tag-counts'
const VEC_AVAILABLE = isVecExtensionAvailable()

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

function itVec(name: string, fn: (db: Database) => void | Promise<void>): void {
  test.skipIf(!VEC_AVAILABLE)(name, () => withVecDb(fn))
}

beforeEach(createTestDb)
afterEach(closeDb)

beforeAll(async () => {
  client = await setupClient()
})

describe('memory_recall search — a tag-filtered search keeps meta.counts honest (task #2532)', () => {
  const TOKEN = 'TAGCNTWIRE'

  itVec('rows the tag filter removes appear in neither total nor filtered_out', async () => {
    const keepA = seedThought({ content: `${TOKEN} keep a`, tags: '["beta"]' })
    const keepB = seedThought({ content: `${TOKEN} keep b`, tags: '["beta"]' })
    seedThought({ content: `${TOKEN} drop a` })
    seedThought({ content: `${TOKEN} drop b` })

    const { data, isError } = parseResult(
      await client.callTool({
        name: 'memory_recall',
        arguments: {
          action: 'search',
          query: TOKEN,
          cwd: UNSCOPED_CWD,
          tag: 'beta',
          limit: 10
        }
      })
    )

    expect(isError).toBe(false)
    expect(data.meta.degraded).toBe(false)
    expect(data.meta.counts).toMatchObject({ total: 2, returned: 2, filtered_out: 0 })
    expect(data.items.map((item: { thought: { id: string } }) => item.thought.id).sort()).toEqual(
      [keepA, keepB].sort()
    )
  })
})

// Recorded pre-fix symptom (e8be9d38): this same call answered `meta.reason: "no_match"` with an
// empty item list, because the SQL predicate compared with ASCII-only NOCASE.
describe('memory_recall search — a non-ASCII tag answers its other case (task #2551)', () => {
  const TOKEN = 'TAGUNIWIRE'

  itVec('a `тег` request answers the stored `Тег` row instead of no_match', async () => {
    const stored = seedThought({ content: `${TOKEN} stored`, tags: '["Тег"]' })

    const { data, isError } = parseResult(
      await client.callTool({
        name: 'memory_recall',
        arguments: {
          action: 'search',
          query: TOKEN,
          cwd: UNSCOPED_CWD,
          tag: 'тег',
          limit: 10
        }
      })
    )

    expect(isError).toBe(false)
    expect(data.meta.reason).toBeUndefined()
    expect(data.meta.degraded).toBe(false)
    expect(data.meta.counts).toMatchObject({ total: 1, returned: 1 })
    expect(data.items.map((item: { thought: { id: string } }) => item.thought.id)).toEqual([stored])
  })
})
