import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer as SdkMcpServer } from '@modelcontextprotocol/server'
import { closeDb } from '../../db/init'
import { createTestDb } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

/**
 * `auto_cluster` option pass-through (task #925 / #930): the handler's
 * numeric-string coercion is asserted on the options object the service
 * receives, so `runAutoCluster` is replaced by a capturing stub.
 *
 * That stub is a process-global `mock.module` with no unmock, and it leaks
 * through the `export *` re-export into every later file of the same `bun test`
 * process — under the serial oracle it silently turned the whole
 * `auto-cluster` fingerprint matrix vacuous (candidates and groups froze at
 * 0, so every probe's confirm was accepted). The suite therefore runs in its
 * own child process, like the degraded contract suites (AGENTS.md §8); the
 * `.contract.test.ts` wrapper next to it spawns it.
 */

mock.module('../../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: () => [new Float32Array(384)],
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

let capturedAutoClusterOptions: Record<string, unknown> | undefined

mock.module('../../services/auto-cluster.service', () => ({
  __esModule: true,
  runAutoCluster: async (options: Record<string, unknown>) => {
    capturedAutoClusterOptions = options
    return { dry_run: true, candidates: 0, groups: [], clusters_created: 0 }
  }
}))

type ToolResult = {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}

function parseResult(result: unknown): { isError: boolean } {
  const r = result as ToolResult
  return { isError: r.isError === true }
}

let client: Client

async function setupClient(): Promise<Client> {
  const server = new SdkMcpServer({ name: 'auto-cluster-mock', version: '0.0.0' })
  registerAllMemoryTools(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const c = new Client({ name: 'test-client', version: '0.0.0' })
  await c.connect(clientTransport)
  return c
}

beforeEach(createTestDb)
afterEach(closeDb)
beforeEach(async () => {
  capturedAutoClusterOptions = undefined
  client = await setupClient()
})

describe('auto_cluster option pass-through over an in-memory MCP client', () => {
  test('numeric-string args are coerced and passed through as numbers', async () => {
    const preview = await client.callTool({
      name: 'memory_crystallize',
      arguments: {
        action: 'auto_cluster',
        min_similarity: '0.68',
        min_members: '5',
        min_age_days: '1'
      }
    })
    const token = JSON.parse((preview as any).content[0].text).meta.preview.token
    const result = await client.callTool({
      name: 'memory_crystallize',
      arguments: {
        action: 'auto_cluster',
        min_similarity: '0.68',
        min_members: '5',
        min_age_days: '1',
        confirm: true,
        preview_token: token
      }
    })
    expect(parseResult(result).isError).toBe(false)
    expect(capturedAutoClusterOptions).toEqual({
      minSimilarity: 0.68,
      minMembers: 5,
      minAgeDays: 1,
      dryRun: false
    })
  })

  test('native-number args are passed through unchanged', async () => {
    const preview = await client.callTool({
      name: 'memory_crystallize',
      arguments: {
        action: 'auto_cluster',
        min_similarity: 0.68,
        min_members: 5,
        min_age_days: 1
      }
    })
    const token = JSON.parse((preview as any).content[0].text).meta.preview.token
    const result = await client.callTool({
      name: 'memory_crystallize',
      arguments: {
        action: 'auto_cluster',
        min_similarity: 0.68,
        min_members: 5,
        min_age_days: 1,
        confirm: true,
        preview_token: token
      }
    })
    expect(parseResult(result).isError).toBe(false)
    expect(capturedAutoClusterOptions).toEqual({
      minSimilarity: 0.68,
      minMembers: 5,
      minAgeDays: 1,
      dryRun: false
    })
  })

  test('omitted optional fields fall back to undefined (service uses config defaults)', async () => {
    const result = await client.callTool({
      name: 'memory_crystallize',
      arguments: { action: 'auto_cluster' }
    })
    expect(parseResult(result).isError).toBe(false)
    expect(capturedAutoClusterOptions).toEqual({
      minAgeDays: undefined,
      minSimilarity: undefined,
      minMembers: undefined,
      dryRun: true
    })
  })
})
