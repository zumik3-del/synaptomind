import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { closeDb } from '../../db/init'
import { type Config, config } from '../../config'
import { configFixture, createTestDb } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

mock.module('../../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: () => [new Float32Array(384)],
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

async function setupClient(cfg?: Config): Promise<Client> {
  const s = new McpServer({ name: 'test', version: '0.0.0' })
  registerAllMemoryTools(s, cfg)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await s.connect(serverTransport)
  const c = new Client({ name: 'test-client', version: '0.0.0' })
  await c.connect(clientTransport)
  return c
}

beforeEach(createTestDb)
afterEach(closeDb)

describe('tool-layer layering guard', () => {
  const TOOLS_DIR = import.meta.dir
  const FORBIDDEN_SPECIFIER = /^(?:\.\.\/)+(?:db|logging)(?:\/|$)|^bun:sqlite$/

  function productionToolFiles(): string[] {
    const files: string[] = []
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) walk(join(dir, entry.name), rel)
        else if (isProductionToolFile(entry.name)) files.push(rel)
      }
    }
    walk(TOOLS_DIR, '')
    return files.sort()
  }

  function isProductionToolFile(name: string): boolean {
    return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.suite.ts')
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
    expect(files).toContain('primers.ts')
    expect(files).toContain('status.ts')
  })

  test('nested tool modules are covered by the guard scan', () => {
    const files = productionToolFiles()
    expect(files).toContain('store/unlink.ts')
    expect(files).toContain('store/retype.ts')
    expect(files).toContain('recall/get.ts')
  })
})

describe('soft-limit single resolution path', () => {
  test('registration description and guide call resolve the same configured value', async () => {
    const client = await setupClient(
      configFixture({ thoughts: { ...config.thoughts, softLimit: 432 } })
    )

    const { tools } = await client.listTools()
    const store = tools.find(t => t.name === 'memory_store')
    expect(JSON.stringify(store?.inputSchema ?? {})).toContain('432')

    const guide = await client.callTool({ name: 'memory_guide', arguments: {} })
    const text = (guide as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain('≤432 soft')
    expect(text).not.toContain('≤600 soft')
  })
})
