import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getDb } from '../../db/container'
import { closeDb, initDb } from '../../db/init'
import { drainPendingEmbeddings, isVecExtensionAvailable, seedThought } from '../../test/helpers'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerAllMemoryTools } from '.'

const VECTOR = new Float32Array(384)
for (let i = 0; i < VECTOR.length; i++) VECTOR[i] = 0.25

mock.module('../../embedder/client', () => ({
  generateEmbedding: async () => VECTOR,
  generateEmbeddings: async () => [VECTOR],
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

let client: Client
let tmpDir: string
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

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'synaptomind-vec-'))
  initDb({ dbPath: join(tmpDir, 'test.db'), runMigrations: true })
  client = await setupClient()
})
afterEach(() => {
  closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('recall context semantic', () => {
  test.skipIf(!isVecExtensionAvailable())('uses real embeddings not empty vector', async () => {
    const db = getDb()
    const id = seedThought({ content: 'semantic context target thought' })
    drainPendingEmbeddings([id])
    const buf = Buffer.from(VECTOR.buffer, VECTOR.byteOffset, VECTOR.byteLength)
    db.prepare(`INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)`).run(id, buf)

    const r = await client.callTool({ name: 'memory_recall', arguments: { action: 'context', query: 'zzzznomatchtoken', compact: false } })
    const { data, isError } = parseResult(r)
    console.log('CTX SEMANTIC:', JSON.stringify(data))
    expect(isError).toBe(false)
    expect(data.best_match.id).toBe(id)
    expect(data.degraded).toBe(false)
  })
})