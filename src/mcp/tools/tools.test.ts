import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getDb } from '../../db/container'
import { closeDb } from '../../db/init'
import { setThoughtLimits } from '../../db/settings'
import { createThought, getThought } from '../../db/thoughts'
import { createTestDb, seedThought } from '../../test/helpers'
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
  test('registers all 11 tools', async () => {
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    expect(names).toContain('memory_recall')
    expect(names).toContain('memory_store')
    expect(names).toContain('memory_supersede')
    expect(names).toContain('memory_status')
    expect(names).toContain('memory_manage')
    expect(names).toContain('memory_crystallize')
    expect(names).toContain('memory_reflect')
    expect(names).toContain('memory_primers')
    expect(names).toContain('edge_review')
    expect(names).toContain('retention_review')
    expect(names).toContain('memory_guide')
    expect(tools.length).toBe(11)
  })

  test('memory_store advertises the effective soft limit at registration', async () => {
    setThoughtLimits(getDb(), 321, 20)

    const fresh = await setupClient()
    const { tools: freshTools } = await fresh.listTools()
    const storeTool = freshTools.find(t => t.name === 'memory_store')
    expect(JSON.stringify(storeTool?.inputSchema ?? {})).toContain('321')
  })
})

describe('retention_review MCP', () => {
  test('maps list pagination and summarizes protection candidates', async () => {
    const id = seedThought({ content: 'MCP retention candidate', status: 'archived', is_protected: 0, importance: 0.1, created_at: '2026-09-01T00:00:00.000Z' })
    getDb().prepare('UPDATE thoughts SET archived_at = ? WHERE id = ?').run('2026-09-01T00:00:00.000Z', id)
    getDb().prepare('UPDATE thought_importance SET importance = 0.1 WHERE thought_id = ?').run(id)
    const listed = parseResult(await client.callTool({ name: 'retention_review', arguments: { action: 'list', min_age_days: 1, importance_floor: 1, limit: 1, offset: 0 } }))
    expect(listed.isError).toBe(false)
    expect(listed.data.candidates.map((row: { id: string }) => row.id)).toContain(id)
    const protectedResult = parseResult(await client.callTool({ name: 'retention_review', arguments: { action: 'protect', thought_id: id } }))
    expect(protectedResult.isError).toBe(false)
    expect(getDb().prepare('SELECT is_protected FROM thoughts WHERE id = ?').get(id)).toEqual({ is_protected: 1 })
  })

  test('previews delete/compact by default and maps confirmation, validation errors, and summary fields', async () => {
    const id = seedThought({ content: 'MCP retention delete', status: 'archived', is_protected: 0, importance: 0.1, created_at: '2026-09-01T00:00:00.000Z' })
    getDb().prepare('UPDATE thoughts SET archived_at = ? WHERE id = ?').run('2026-09-01T00:00:00.000Z', id)
    getDb().prepare('UPDATE thought_importance SET importance = 0.1 WHERE thought_id = ?').run(id)
    const preview = parseResult(await client.callTool({ name: 'retention_review', arguments: { action: 'delete', thought_id: id } }))
    expect(preview.data.preview).toBe(true)
    expect(getDb().prepare('SELECT id FROM thoughts WHERE id = ?').get(id)).toBeTruthy()
    const deletePreview = parseResult(await client.callTool({ name: 'retention_review', arguments: { action: 'delete', thought_id: id } }))
    const deleted = parseResult(await client.callTool({ name: 'retention_review', arguments: { action: 'delete', thought_id: id, confirm: true, preview_token: deletePreview.data.preview_token } }))
    expect(deleted.data.deleted).toBe(true)

    const source = seedThought({ content: 'MCP retention compact source', status: 'archived', is_protected: 0, importance: 0.1, created_at: '2026-09-01T00:00:00.000Z' })
    getDb().prepare('UPDATE thoughts SET archived_at = ? WHERE id = ?').run('2026-09-01T00:00:00.000Z', source)
    getDb().prepare('UPDATE thought_importance SET importance = 0.1 WHERE thought_id = ?').run(source)
    const args = { action: 'compact', source_ids: [source], summary: { content: 'MCP retention compact summary', tags: ['mcp-tag'], project_id: 'default' } }
    const compactPreview = parseResult(await client.callTool({ name: 'retention_review', arguments: args }))
    expect(compactPreview.data.status).toBe('preview')
    expect(getDb().prepare("SELECT id FROM thoughts WHERE content = 'MCP retention compact summary'").get()).toBeNull()
    const compacted = parseResult(await client.callTool({ name: 'retention_review', arguments: { ...args, confirm: true } }))
    expect(compacted.isError).toBe(false)
    expect(compacted.data.summary.project_id).toBe('default')
    expect(compacted.data.summary.tags.map((tag: { name: string }) => tag.name)).toContain('mcp-tag')
    const invalid = parseResult(await client.callTool({ name: 'retention_review', arguments: { action: 'compact', source_ids: [], summary: { content: 'invalid' } } }))
    expect(invalid.isError).toBe(true)
    const edgeTools = (await client.listTools()).tools.filter(tool => tool.name === 'edge_review')
    expect(edgeTools).toHaveLength(1)
  })

  test('retention-review compact rejects more than 1000 IDs through MCP validation', async () => {
    const result = await client.callTool({ name: 'retention_review', arguments: {
      action: 'compact', source_ids: Array.from({ length: 1001 }, (_, i) => `id-${i}`), summary: { content: 'summary' }
    } })
    expect(result.isError).toBe(true)
  })

  test('retention-review list excludes profile thoughts and totals', async () => {
    const candidate = seedThought({ content: 'candidate', status: 'archived', is_profile: 0, is_protected: 0, created_at: '2026-09-01T00:00:00.000Z' })
    const profile = seedThought({ content: 'profile', status: 'archived', is_profile: 1, is_protected: 0, created_at: '2026-09-01T00:00:00.000Z' })
    for (const id of [candidate, profile]) {
      getDb().prepare('UPDATE thoughts SET archived_at = ? WHERE id = ?').run('2026-09-01T00:00:00.000Z', id)
      getDb().prepare('UPDATE thought_importance SET importance = 0.1 WHERE thought_id = ?').run(id)
    }
    const listed = parseResult(await client.callTool({ name: 'retention_review', arguments: { action: 'list' } }))
    expect(listed.data.candidates.map((row: { id: string }) => row.id)).toContain(candidate)
    expect(listed.data.candidates.map((row: { id: string }) => row.id)).not.toContain(profile)
    expect(listed.data.total).toBe(1)
  })

  test('retention-review delete, protect, and compact refuse profile thoughts', async () => {
    const id = seedThought({ status: 'archived', is_profile: 1, is_protected: 0, created_at: '2026-09-01T00:00:00.000Z' })
    for (const args of [
      { action: 'delete', thought_id: id, confirm: true },
      { action: 'protect', thought_id: id },
      { action: 'compact', source_ids: [id], summary: { content: 'summary' }, confirm: true }
    ]) {
      let result: { isError?: boolean }
      if (args.action === 'delete') {
        const pv = parseResult(await client.callTool({ name: 'retention_review', arguments: { action: 'delete', thought_id: id } }))
        if (pv.isError) {
          result = pv
        } else {
          result = parseResult(await client.callTool({ name: 'retention_review', arguments: { ...args, preview_token: pv.data?.preview_token } }))
        }
      } else {
        result = parseResult(await client.callTool({ name: 'retention_review', arguments: args }))
      }
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result).toLowerCase()).toContain('profile')
    }
  })

  test('retention-review compact accepts 1000 source IDs through MCP schema validation', async () => {
    const result = parseResult(await client.callTool({ name: 'retention_review', arguments: {
      action: 'compact', source_ids: Array.from({ length: 1000 }, (_, i) => `missing-${i}`), summary: { content: 'summary' }
    } }))
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result).toLowerCase()).not.toContain('at most 1000')
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
      arguments: { action: 'link', source_id: da.id, target_id: db.id, edge_type: 'develops' }
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
      arguments: { action: 'search', query: 'MCP_CONTRACT_MARKER', limit: 5 }
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
      arguments: { action: 'clusters', query: 'cluster', limit: 5 }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(Array.isArray(data)).toBe(true)
    expect(data.every((r: any) => r.thought?.is_cluster === 1)).toBe(true)
  })

  test('search without query returns error', async () => {
    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search' }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(true)
    expect(data).toContain('query is required for search action')
  })

  test('context without query returns error', async () => {
    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'context' }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(true)
    expect(data).toContain('query or thought_id is required for context action')  })

  test('clusters without query returns error', async () => {
    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'clusters' }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(true)
    expect(data).toContain('query is required for clusters action')
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

    const preview = await client.callTool({
      name: 'memory_supersede',
      arguments: { action: 'archive', thought_id: thought.id }
    })
    const token = parseResult(preview).data.preview_token
    const result = await client.callTool({
      name: 'memory_supersede',
      arguments: { action: 'archive', thought_id: thought.id, confirm: true, preview_token: token }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data).toMatchObject({ status: 'executed', action: 'archive', result: { id: thought.id, status: 'archived' } })
  })

  test('double archive is idempotent (regression #76)', async () => {
    const create = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'double archive test' }
    })
    const { data: thought } = parseResult(create)

    const preview1 = await client.callTool({
      name: 'memory_supersede',
      arguments: { action: 'archive', thought_id: thought.id }
    })
    await client.callTool({
      name: 'memory_supersede',
      arguments: { action: 'archive', thought_id: thought.id, confirm: true, preview_token: parseResult(preview1).data.preview_token }
    })
    const preview2 = await client.callTool({
      name: 'memory_supersede',
      arguments: { action: 'archive', thought_id: thought.id }
    })
    const second = await client.callTool({
      name: 'memory_supersede',
      arguments: { action: 'archive', thought_id: thought.id, confirm: true, preview_token: parseResult(preview2).data.preview_token }
    })
    const { data, isError } = parseResult(second)
    expect(isError).toBe(false)
    expect(data).toMatchObject({ status: 'executed', action: 'archive', result: { id: thought.id, status: 'archived' } })
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

    const mergePreview = await client.callTool({
      name: 'memory_supersede',
      arguments: {
        action: 'merge',
        source_id: source.id,
        target_id: target.id,
        merged_content: 'merged result'
      }
    })
    const result = await client.callTool({
      name: 'memory_supersede',
      arguments: {
        action: 'merge',
        source_id: source.id,
        target_id: target.id,
        merged_content: 'merged result',
        confirm: true,
        preview_token: parseResult(mergePreview).data.preview_token
      }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data).toMatchObject({ status: 'executed', action: 'merge', result: { target: { id: target.id, content: 'merged result' } } })

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
  test('advertises only the three surviving graph and cluster actions', async () => {
    const { tools } = await client.listTools()
    const tool = tools.find(t => t.name === 'memory_crystallize')
    const schema = tool?.inputSchema as { properties?: { action?: { enum?: string[] } } } | undefined
    expect(schema?.properties?.action?.enum).toEqual([
      'graph', 'cluster', 'auto_cluster'
    ])
  })

  test('rejects retired crystallize action through MCP', async () => {
    const result = await client.callTool({ name: 'memory_crystallize', arguments: { action: 'crystallize' } })
    expect(parseResult(result).isError).toBe(true)
  })

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

  test('dispatches cluster creation and auto-cluster', async () => {
    const member = seedThought({ content: 'retained cluster member' })
    const created = parseResult(await client.callTool({
      name: 'memory_crystallize', arguments: { action: 'cluster', thought_ids: [member], title: 'retained cluster' }
    }))
    expect(created.isError).toBe(false)
    expect(created.data.cluster.id).toBeDefined()

    const autoPreview = parseResult(await client.callTool({
      name: 'memory_crystallize', arguments: { action: 'auto_cluster' }
    }))
    const auto = parseResult(await client.callTool({
      name: 'memory_crystallize', arguments: { action: 'auto_cluster', confirm: true, preview_token: autoPreview.data.preview_token }
    }))
    expect(auto.isError).toBe(false)
  })

  test('historical crystal-source thought remains accessible through get and search', async () => {
    const id = seedThought({ content: 'unique historic crystal archival record', source: 'crystal', status: 'active' })
    const get = parseResult(await client.callTool({
      name: 'memory_recall', arguments: { action: 'get', thought_id: id, compact: false }
    }))
    expect(get.data.source).toBe('crystal')

    const search = parseResult(await client.callTool({
      name: 'memory_recall', arguments: { action: 'search', query: 'unique historic crystal archival record', hybrid: true, compact: false }
    }))
    expect(JSON.stringify(search.data)).toContain(id)
  })
})

// ── memory_primers ───────────────────────────────────────────────────────────

describe('memory_primers', () => {
  test('list returns array', async () => {
    const result = await client.callTool({
      name: 'memory_primers',
      arguments: { action: 'list' }
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

  test('advertises the effective soft limit resolved at call time', async () => {
    setThoughtLimits(getDb(), 123, 20)

    const result = await client.callTool({ name: 'memory_guide', arguments: {} })
    const r = result as { content: Array<{ type: string; text: string }> }
    expect(r.content[0].text).toContain('≤123 soft')
    expect(r.content[0].text).not.toContain('≤600 soft')
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

// ── Edge cases ───────────────────────────────────────────────────────────────

describe('merge edge cases', () => {
  test('merge with project_id argument succeeds', async () => {
    const a = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'source with project' }
    })
    const b = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'target with project' }
    })
    const { data: source } = parseResult(a)
    const { data: target } = parseResult(b)

    const mergePreview = await client.callTool({
      name: 'memory_supersede',
      arguments: { action: 'merge', source_id: source.id, target_id: target.id, merged_content: 'merged' }
    })
    const result = await client.callTool({
      name: 'memory_supersede',
      arguments: { action: 'merge', source_id: source.id, target_id: target.id, merged_content: 'merged', confirm: true, preview_token: parseResult(mergePreview).data.preview_token }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data).toMatchObject({ status: 'executed', action: 'merge', result: { target: { id: target.id, content: 'merged' } } })
    const targetCheck = await client.callTool({ name: 'memory_recall', arguments: { action: 'get', thought_id: target.id } })
    expect(parseResult(targetCheck).data.content).toBe('merged')
  })

  test('merge with archived source returns error', async () => {
    const a = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'archived source' }
    })
    const { data: source } = parseResult(a)
    const archPreview = await client.callTool({
      name: 'memory_supersede',
      arguments: { action: 'archive', thought_id: source.id }
    })
    await client.callTool({
      name: 'memory_supersede',
      arguments: { action: 'archive', thought_id: source.id, confirm: true, preview_token: parseResult(archPreview).data.preview_token }
    })

    const b = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'target' }
    })
    const { data: target } = parseResult(b)

    const mergePreview2 = await client.callTool({
      name: 'memory_supersede',
      arguments: { action: 'merge', source_id: source.id, target_id: target.id }
    })
    const result = await client.callTool({
      name: 'memory_supersede',
      arguments: { action: 'merge', source_id: source.id, target_id: target.id, confirm: true, preview_token: parseResult(mergePreview2).data.preview_token }
    })
    const { isError } = parseResult(result)
    expect(isError).toBe(true)
  })
})

describe('archive edge cases', () => {
  test('archive on profile thought returns error', async () => {
    // Legacy profile data still exists in deployed DBs even though the flag is
    // no longer writable through the API/MCP surface (task #1939), so the
    // archive guard is seeded at the db layer.
    const thought = createThought(getDb(), { content: 'profile thought', status: 'active', is_profile: true })

    const archPreview = await client.callTool({
      name: 'memory_supersede',
      arguments: { action: 'archive', thought_id: thought.id }
    })
    const result = await client.callTool({
      name: 'memory_supersede',
      arguments: { action: 'archive', thought_id: thought.id, confirm: true, preview_token: parseResult(archPreview).data.preview_token }
    })
    const { isError } = parseResult(result)
    expect(isError).toBe(true)
  })
})

// ── link edge types (epic #141: contradicts / supports) ──────────────────────

describe('memory_store link edge types', () => {
  async function createPair(): Promise<{ a: string; b: string }> {
    const a = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'source claim' }
    })
    const b = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'target claim' }
    })
    return { a: parseResult(a).data.id, b: parseResult(b).data.id }
  }

  test('accepts contradicts and is idempotent in both directions', async () => {
    const { a, b } = await createPair()

    const forward = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'link', source_id: a, target_id: b, edge_type: 'contradicts' }
    })
    const { data: edge, isError } = parseResult(forward)
    expect(isError).toBe(false)
    expect(edge.type).toBe('contradicts')
    expect(edge.source_id).toBe(a)
    expect(edge.target_id).toBe(b)

    const reverse = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'link', source_id: b, target_id: a, edge_type: 'contradicts' }
    })
    expect(parseResult(reverse).isError).toBe(false)
    expect(parseResult(reverse).data.id).toBe(edge.id)
  })

  test('accepts supports and rejects a reverse duplicate', async () => {
    const { a, b } = await createPair()

    const forward = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'link', source_id: a, target_id: b, edge_type: 'supports' }
    })
    const { data: edge, isError } = parseResult(forward)
    expect(isError).toBe(false)
    expect(edge.type).toBe('supports')
    expect(edge.source_id).toBe(a)

    const reverse = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'link', source_id: b, target_id: a, edge_type: 'supports' }
    })
    expect(parseResult(reverse).isError).toBe(true)
  })

  test('rejects an invalid edge_type', async () => {
    const { a, b } = await createPair()
    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'link', source_id: a, target_id: b, edge_type: 'frobnicates' }
    })
    expect(parseResult(result).isError).toBe(true)
  })

  test('the removed edge_suggestions action is no longer advertised', async () => {
    const { tools } = await client.listTools()
    const status = tools.find(t => t.name === 'memory_status')
    expect(status).toBeDefined()
    const schema = status!.inputSchema as Record<string, any>
    expect(schema.properties.action.enum).not.toContain('edge_suggestions')
  })
})

describe('search with project scope', () => {
  test('projectFilter scopes search results', async () => {
    const proj = await client.callTool({
      name: 'memory_manage',
      arguments: { action: 'create', name: 'SearchScopeTest', local_path: '/tmp/search-scope' }
    })
    const { data: project } = parseResult(proj)

    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'SCOPED_MARKER in project', status: 'active', cwd: '/tmp/search-scope' }
    })
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'SCOPED_MARKER in default', status: 'active' }
    })

    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: 'SCOPED_MARKER', limit: 10, cwd: '/tmp/search-scope', compact: false }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(data.length).toBeGreaterThanOrEqual(1)
    expect(data.every((r: any) => r.thought?.project_id === project.id)).toBe(true)
  })
})

// ── Ranking signal fields (issue #143, task #816) ────────────────────────────

describe('memory_recall ranking signals', () => {
  async function searchWithSignals(query: string, extra?: Record<string, unknown>) {
    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query, limit: 10, ...extra }
    })
    return parseResult(result)
  }

  test('search response includes match_source on every result', async () => {
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'SIGNALS_MARKER bm25 relevant content here', status: 'active' }
    })

    const { data, isError } = await searchWithSignals('SIGNALS_MARKER')
    expect(isError).toBe(false)
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThanOrEqual(1)
    // Every result must carry match_source (always present per SearchResult contract)
    expect(data.every((r: any) => Array.isArray(r.match_source))).toBe(true)
  })

  test('BM25 hit carries a positive bm25_score', async () => {
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'SIGNALS_BM25 unique keyword marker alpha', status: 'active' }
    })
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'SIGNALS_BM25 unique keyword marker beta', status: 'active' }
    })

    const { data, isError } = await searchWithSignals('SIGNALS_BM25 unique keyword marker')
    expect(isError).toBe(false)
    const results = data as Array<{ thought: { id: string }; match_source: string[]; bm25_score?: number }>
    const bm25Hits = results.filter((r) => r.match_source.includes('bm25'))
    expect(bm25Hits.length).toBeGreaterThanOrEqual(1)
    bm25Hits.forEach((r) => {
      expect(typeof r.bm25_score).toBe('number')
      expect(r.bm25_score).toBeGreaterThan(0)
    })
  })

  test('hybrid path carries rrf_score on merged results', async () => {
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'SIGNALS_RRF hybrid fusion marker', status: 'active' }
    })

    const { data, isError } = await searchWithSignals('SIGNALS_RRF hybrid fusion marker')
    expect(isError).toBe(false)
    const results = data as Array<{ match_source: string[]; rrf_score?: number }>
    // On the hybrid path, every returned result that matched any leg should have rrf_score
    const withRrf = results.filter((r) => r.match_source.length > 0)
    expect(withRrf.length).toBeGreaterThanOrEqual(1)
    // rrf_score is present when fusion ran (hybrid=true is the default)
    expect(withRrf.every((r) => r.rrf_score !== undefined)).toBe(true)
  })
})

// ── Recency boost (issue #145, task #821) ─────────────────────────────────────

describe('memory_recall recency boost', () => {
  async function searchWithRecency(query: string, extra?: Record<string, unknown>) {
    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query, limit: 10, ...extra }
    })
    return parseResult(result)
  }

  test('recency_weight accepted; response carries recency_score and final_score', async () => {
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'REC_MCP marker content here', status: 'active' }
    })

    const { data, isError } = await searchWithRecency('REC_MCP marker content here', { recency_weight: 0.5 })
    expect(isError).toBe(false)
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThanOrEqual(1)
    // Every result should carry recency fields when weight > 0.
    const results = data as Array<{ recency_score?: number; final_score?: number }>
    expect(results.every((r) => r.recency_score !== undefined)).toBe(true)
    expect(results.every((r) => r.final_score !== undefined)).toBe(true)
  })

  test('unset recency_weight → neither recency_score nor final_score present', async () => {
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'REC_MCP_UNSET marker content here', status: 'active' }
    })

    const { data, isError } = await searchWithRecency('REC_MCP_UNSET marker content here')
    expect(isError).toBe(false)
    expect(Array.isArray(data)).toBe(true)
    const results = data as Array<{ recency_score?: number; final_score?: number }>
    // Default weight=0 → fields must be absent (backward compat).
    expect(results.every((r) => r.recency_score === undefined)).toBe(true)
    expect(results.every((r) => r.final_score === undefined)).toBe(true)
  })

  test('schema rejects out-of-range recency_weight', async () => {
    // Negative weight.
    const neg = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: 'test', recency_weight: -0.1 }
    })
    expect(parseResult(neg).isError).toBe(true)

    // Weight above 1.
    const over = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: 'test', recency_weight: 1.1 }
    })
    expect(parseResult(over).isError).toBe(true)
  })
})

// ── Relevance-confidence signal (issue #155, task #884/885) ──────────────────

describe('memory_recall low_confidence + min_relevance', () => {
  test('search response includes low_confidence on every result', async () => {
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'LC_MCP marker relevant content here', status: 'active' }
    })

    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: 'LC_MCP marker relevant content' }
    })
    const { data, isError } = parseResult(result)
    expect(isError).toBe(false)
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThanOrEqual(1)
    for (const r of data) {
      expect(typeof r.low_confidence).toBe('boolean')
    }
  })

  test('search accepts min_relevance argument', async () => {
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'LC_MIN_REL marker content', status: 'active' }
    })

    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: 'LC_MIN_REL marker content', min_relevance: 0.5 }
    })
    const { isError } = parseResult(result)
    expect(isError).toBe(false)
  })

  test('clusters action accepts min_relevance argument', async () => {
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'LC_CLUST marker cluster content', status: 'active' }
    })

    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'clusters', query: 'LC_CLUST marker cluster content', min_relevance: 0.5 }
    })
    const { isError } = parseResult(result)
    expect(isError).toBe(false)
  })

  test('schema rejects min_relevance < 0', async () => {
    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: 'test', min_relevance: -0.1 }
    })
    expect(parseResult(result).isError).toBe(true)
  })

  test('schema rejects min_relevance > 1', async () => {
    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: 'test', min_relevance: 1.1 }
    })
    expect(parseResult(result).isError).toBe(true)
  })

  test('min_relevance=0 returns same results as default (no gating)', async () => {
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'LC_EQUIV equivalent marker test', status: 'active' }
    })

    const defaultResult = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: 'LC_EQUIV equivalent marker test' }
    })
    const zeroResult = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: 'LC_EQUIV equivalent marker test', min_relevance: 0 }
    })

    const defaultData = parseResult(defaultResult).data as Array<{ thought: { id: string } }>
    const zeroData = parseResult(zeroResult).data as Array<{ thought: { id: string } }>
    const defaultIds = defaultData.map(r => r.thought.id).sort()
    const zeroIds = zeroData.map(r => r.thought.id).sort()
    expect(zeroIds).toEqual(defaultIds)
  })
})

// ── Retired surface (pruning batch) ──────────────────────────────────────────
//
// The pruning batch removed `is_profile`, the `profile` status action and the
// `cluster_remove`/`cluster_dissolve` crystallize actions. The retired keys and
// action names stay in the input schemas so the refusal is a readable message
// rather than a silently ignored argument: the contract is "refused loudly",
// not "accepted and dropped".

describe('retired surface', () => {
  test('memory_store create refuses is_profile and writes nothing', async () => {
    const before = (getDb().query('select count(*) as n from thoughts').get() as { n: number }).n
    const { data, isError } = parseResult(await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'retired profile flag', is_profile: true }
    }))
    expect(isError).toBe(true)
    expect(String(data)).toContain('is_profile is retired')
    const after = (getDb().query('select count(*) as n from thoughts').get() as { n: number }).n
    expect(after).toBe(before)
  })

  test('memory_store update refuses is_profile and leaves the row untouched', async () => {
    const created = parseResult(await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'plain thought' }
    }))
    const id = created.data.id as string
    const { data, isError } = parseResult(await client.callTool({
      name: 'memory_store',
      arguments: { action: 'update', thought_id: id, is_profile: true }
    }))
    expect(isError).toBe(true)
    expect(String(data)).toContain('is_profile is retired')
    expect(getThought(getDb(), id)?.is_profile).toBe(0)
  })

  test('memory_status action=profile is no longer a valid action', async () => {
    const { data, isError } = parseResult(await client.callTool({
      name: 'memory_status',
      arguments: { action: 'profile' }
    }))
    expect(isError).toBe(true)
    expect(String(data)).toContain('Invalid option: expected one of')
  })

  for (const action of ['cluster_remove', 'cluster_dissolve']) {
    test(`memory_crystallize ${action} is refused with the surviving action enum`, async () => {
      const { data, isError } = parseResult(await client.callTool({
        name: 'memory_crystallize',
        arguments: { action }
      }))
      expect(isError).toBe(true)
      expect(String(data)).toContain('expected one of "graph"|"cluster"|"auto_cluster"')
    })
  }
})
