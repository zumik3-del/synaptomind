import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { closeDb } from '../../db/init'
import { createTestDb } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

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

// ── Tool registration ────────────────────────────────────────────────────────

describe('tool registration', () => {
  test('registers all 9 tools', async () => {
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    expect(names).toContain('memory_recall')
    expect(names).toContain('memory_store')
    expect(names).toContain('memory_supersede')
    expect(names).toContain('memory_status')
    expect(names).toContain('memory_manage')
    expect(names).toContain('memory_crystallize')
    expect(names).toContain('memory_reflect')
    expect(names).toContain('memory_telemetry')
    expect(names).toContain('memory_guide')
    expect(tools.length).toBe(9)
  })
})

// ── memory_store ─────────────────────────────────────────────────────────────

describe('memory_store', () => {
  test('create action creates a thought', async () => {
    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'test thought from MCP' }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.id).toBeDefined()
    expect(data.content).toBe('test thought from MCP')
    expect(data.status).toBe('draft')
  })

  test('create with tags stores tags', async () => {
    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'tagged thought', tags: ['alpha', 'beta'] }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.tags.map((t: any) => t.name).sort()).toEqual(['alpha', 'beta'])
  })

  test('update action modifies content', async () => {
    const create = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'original content' }
    })
    const { data: created } = parseResult(create)

    const update = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'update', thought_id: created.id, content: 'updated content' }
    })
    const { data: updated, isError } = parseResult(update)
    expect(isError).toBe(false)
    expect(updated.content).toBe('updated content')
  })

  test('link action creates an edge', async () => {
    const a = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'source thought' }
    })
    const b = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'target thought' }
    })
    const { data: da } = parseResult(a)
    const { data: db } = parseResult(b)

    const link = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'link', thought_id: da.id, target_id: db.id, edge_type: 'develops' }
    })
    const { data: edge, isError } = parseResult(link)
    expect(isError).toBe(false)
    expect(edge.source_id).toBe(da.id)
    expect(edge.target_id).toBe(db.id)
    expect(edge.type).toBe('develops')
  })

  test('error: create without content returns error', async () => {
    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create' }
    })
    const { isError } = parseResult(result)
    expect(isError).toBe(true)
  })

  test('error: update nonexistent thought returns error', async () => {
    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'update', thought_id: 'nonexistent-id', content: 'x' }
    })
    const { isError } = parseResult(result)
    expect(isError).toBe(true)
  })
})

// ── memory_recall ────────────────────────────────────────────────────────────

describe('memory_recall', () => {
  test('search returns matching thoughts', async () => {
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'MCP_CONTRACT_MARKER unique search term', status: 'active' }
    })

    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: 'MCP_CONTRACT_MARKER', top_k: 5 }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThanOrEqual(1)
    expect(data.some((r: any) => r.thought?.content?.includes('MCP_CONTRACT_MARKER'))).toBe(true)
  })

  test('get returns a thought by id', async () => {
    const create = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'gettable thought' }
    })
    const { data: created } = parseResult(create)

    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'get', thought_id: created.id }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.id).toBe(created.id)
    expect(data.content).toBe('gettable thought')
  })

  test('get: nonexistent id returns error', async () => {
    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'get', thought_id: 'does-not-exist' }
    })
    const { isError } = parseResult(result)
    expect(isError).toBe(true)
  })

  test('clusters returns only cluster thoughts', async () => {
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'regular thought' }
    })
    const cl = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'cluster marker' }
    })
    const { data: cluster } = parseResult(cl)
    const { getDb } = await import('../../db/container')
    const db = getDb()
    db.prepare('UPDATE thoughts SET is_cluster = 1 WHERE id = ?').run(cluster.id)

    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'clusters', query: 'cluster', top_k: 5 }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(Array.isArray(data)).toBe(true)
    expect(data.every((r: any) => r.thought?.is_cluster === 1)).toBe(true)
  })
})

// ── memory_supersede (regression focus) ──────────────────────────────────────

describe('memory_supersede', () => {
  test('archive sets status to archived', async () => {
    const create = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'to be archived' }
    })
    const { data: thought } = parseResult(create)

    const result = await client.callTool({
      name: 'memory_supersede',
      arguments: { action: 'archive', thought_id: thought.id }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.status).toBe('archived')
  })

  test('double archive is idempotent (regression #76)', async () => {
    const create = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'double archive test' }
    })
    const { data: thought } = parseResult(create)

    await client.callTool({
      name: 'memory_supersede',
      arguments: { action: 'archive', thought_id: thought.id }
    })
    const second = await client.callTool({
      name: 'memory_supersede',
      arguments: { action: 'archive', thought_id: thought.id }
    })
    const { data, isError } = parseResult(second)
    expect(isError).toBe(false)
    expect(data.status).toBe('archived')
    expect(data.id).toBe(thought.id)
  })

  test('merge archives source and updates target (regression #76)', async () => {
    const a = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'source thought A' }
    })
    const b = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'target thought B' }
    })
    const { data: source } = parseResult(a)
    const { data: target } = parseResult(b)

    const result = await client.callTool({
      name: 'memory_supersede',
      arguments: {
        action: 'merge',
        source_id: source.id,
        target_id: target.id,
        merged_content: 'merged result'
      }
    })
    const { isError } = parseResult(result)
    expect(isError).toBe(false)

    const srcCheck = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'get', thought_id: source.id }
    })
    const { data: srcData } = parseResult(srcCheck)
    expect(srcData.status).toBe('archived')

    const tgtCheck = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'get', thought_id: target.id }
    })
    const { data: tgtData } = parseResult(tgtCheck)
    expect(tgtData.content).toBe('merged result')
  })
})

// ── memory_manage ────────────────────────────────────────────────────────────

describe('memory_manage', () => {
  test('list returns projects array', async () => {
    const result = await client.callTool({
      name: 'memory_manage',
      arguments: { action: 'list' }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThanOrEqual(1)
  })

  test('create and resolve project', async () => {
    const create = await client.callTool({
      name: 'memory_manage',
      arguments: { action: 'create', name: 'TestProject', local_path: '/tmp/test-project' }
    })
    const { data: project, isError: createErr } = parseResult(create)
    expect(createErr).toBe(false)
    expect(project.name).toBe('TestProject')

    const resolve = await client.callTool({
      name: 'memory_manage',
      arguments: { action: 'resolve', cwd: '/tmp/test-project' }
    })
    const { data: resolved, isError: resolveErr } = parseResult(resolve)
    expect(resolveErr).toBe(false)
    expect(resolved.name).toBe('TestProject')
  })
})

// ── memory_reflect ───────────────────────────────────────────────────────────

describe('memory_reflect', () => {
  test('reflect with summary succeeds', async () => {
    const result = await client.callTool({
      name: 'memory_reflect',
      arguments: { action: 'reflect', summary: 'Session completed successfully' }
    })
    const { isError } = parseResult(result)
    expect(isError).toBe(false)
  })

  test('timeline lists thoughts', async () => {
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'timeline item 1' }
    })
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'timeline item 2' }
    })

    const result = await client.callTool({
      name: 'memory_reflect',
      arguments: { action: 'timeline', limit: 5 }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThanOrEqual(2)
  })
})

// ── memory_status ────────────────────────────────────────────────────────────

describe('memory_status', () => {
  test('slots returns slot data', async () => {
    const result = await client.callTool({
      name: 'memory_status',
      arguments: { action: 'slots' }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data).toBeDefined()
  })

  test('frontier returns items', async () => {
    const result = await client.callTool({
      name: 'memory_status',
      arguments: { action: 'frontier' }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.items).toBeDefined()
    expect(Array.isArray(data.items)).toBe(true)
  })

  test('config returns config text', async () => {
    const result = await client.callTool({
      name: 'memory_status',
      arguments: { action: 'config' }
    })
    const r = result as { content: Array<{ type: string; text: string }> }
    expect(r.content[0].text).toContain('SynaptoMind Configuration')
  })
})

// ── memory_crystallize ───────────────────────────────────────────────────────

describe('memory_crystallize', () => {
  test('graph returns nodes and edges', async () => {
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'graph node' }
    })

    const result = await client.callTool({
      name: 'memory_crystallize',
      arguments: { action: 'graph' }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(Array.isArray(data.nodes)).toBe(true)
    expect(Array.isArray(data.edges)).toBe(true)
  })
})

// ── memory_telemetry ─────────────────────────────────────────────────────────

describe('memory_telemetry', () => {
  test('primers list returns array', async () => {
    const result = await client.callTool({
      name: 'memory_telemetry',
      arguments: { action: 'primers', primer_action: 'list' }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(Array.isArray(data)).toBe(true)
  })
})

// ── memory_guide ─────────────────────────────────────────────────────────────

describe('memory_guide', () => {
  test('returns guide text', async () => {
    const result = await client.callTool({
      name: 'memory_guide',
      arguments: {}
    })
    const r = result as { content: Array<{ type: string; text: string }> }
    expect(r.content[0].text).toContain('SynaptoMind')
    expect(r.content[0].text).toContain('memory_store')
  })
})

// ── Schema validation ────────────────────────────────────────────────────────

describe('schema validation', () => {
  test('unknown action on memory_store returns error', async () => {
    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'nonexistent' }
    })
    const { isError } = parseResult(result)
    expect(isError).toBe(true)
  })

  test('unknown action on memory_recall returns error', async () => {
    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'nonexistent', query: 'test' }
    })
    const { isError } = parseResult(result)
    expect(isError).toBe(true)
  })

  test('unknown action on memory_supersede returns error', async () => {
    const result = await client.callTool({
      name: 'memory_supersede',
      arguments: { action: 'nonexistent' }
    })
    const { isError } = parseResult(result)
    expect(isError).toBe(true)
  })
})

// ── Regression: dedup after update ───────────────────────────────────────────

describe('dedup after update (regression #76)', () => {
  test('create after update creates new thought, not stale one', async () => {
    const c1 = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'original content' }
    })
    const { data: t1 } = parseResult(c1)

    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'update', thought_id: t1.id, content: 'changed content' }
    })

    const c2 = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'original content' }
    })
    const { data: t2 } = parseResult(c2)

    expect(t2.id).not.toBe(t1.id)
    expect(t2.content).toBe('original content')
  })
})
