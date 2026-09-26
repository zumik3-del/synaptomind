import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { closeDb } from '../../db/init'
import { setThoughtLimits } from '../../db/settings'
import { createTestDb } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

// Thin-tools regression coverage for task #165 (findings F2/F11/F13):
//  - the tool layer must not import the db/logging layer directly (F2/F11),
//  - the soft limit must resolve through one path at registration and call time
//    (F13).
mock.module('../../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: () => [new Float32Array(384)],
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

async function setupClient(): Promise<Client> {
  const s = new McpServer({ name: 'test', version: '0.0.0' })
  registerAllMemoryTools(s)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await s.connect(serverTransport)
  const c = new Client({ name: 'test-client', version: '0.0.0' })
  await c.connect(clientTransport)
  return c
}

beforeEach(createTestDb)
afterEach(closeDb)

// ── Static layering guard ────────────────────────────────────────────────────

describe('tool-layer layering guard', () => {
  const TOOLS_DIR = import.meta.dir
  // `../../db/...` and `../../logging` are the only escape hatches into the
  // persistence/logging layers; bun:sqlite is the raw driver. Services are the
  // only sanctioned dependency of the MCP tool layer.
  const FORBIDDEN_SPECIFIER = /^(?:\.\.\/)+(?:db|logging)(?:\/|$)|^bun:sqlite$/

  function productionToolFiles(): string[] {
    return readdirSync(TOOLS_DIR)
      .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.suite.ts'))
      .sort()
  }

  function importSpecifiers(source: string): string[] {
    const specs: string[] = []
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) specs.push(match[1])
    for (const match of source.matchAll(/import\s+['"]([^'"]+)['"]/g)) specs.push(match[1])
    return specs
  }

  test('no production tool module imports the db or logging layer', () => {
    const violations = productionToolFiles().flatMap(file => {
      const source = readFileSync(join(TOOLS_DIR, file), 'utf8')
      return importSpecifiers(source)
        .filter(spec => FORBIDDEN_SPECIFIER.test(spec))
        .map(spec => `${file} -> ${spec}`)
    })
    expect(violations).toEqual([])
  })

  test('the previously leaking tools are covered by the guard scan', () => {
    const files = productionToolFiles()
    expect(files).toContain('store.ts')
    expect(files).toContain('guide.ts')
    expect(files).toContain('telemetry.ts')
    expect(files).toContain('status.ts')
  })
})
// ── soft limit single source (F13) ───────────────────────────────────────────

describe('soft-limit single resolution path', () => {
  test('registration description and guide call resolve the same DB-backed value', async () => {
    setThoughtLimits(432, 20)
    const client = await setupClient()

    const { tools } = await client.listTools()
    const store = tools.find(t => t.name === 'memory_store')
    expect(JSON.stringify(store?.inputSchema ?? {})).toContain('432')

    const guide = await client.callTool({ name: 'memory_guide', arguments: {} })
    const text = (guide as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain('≤432 soft')
    expect(text).not.toContain('≤600 soft')
  })
})
