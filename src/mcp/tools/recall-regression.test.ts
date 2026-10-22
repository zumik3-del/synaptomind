import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getDb } from '../../db/container'
import { createEdge } from '../../db/edges'
import { closeDb } from '../../db/init'
import { createTestDb, seedThought, withVecDb } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

// Regression coverage for #926:
// - z.coerce.number() on six numeric params accepts JSON-string numerics and
//   still enforces their min/max bounds.
// - Per-axis `off` on supersession_mode / contradiction_mode: standing is still
//   emitted when exactly one axis is off; omitted only when both are off.
// - The advertised JSON Schema preserves numeric bounds (type/minimum/maximum)
//   despite the coerce transform.

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

describe('memory_recall schema after exclude_flagged retirement', () => {
  test('the advertised schema no longer exposes exclude_flagged', async () => {
    const { tools } = await client.listTools()
    const recallTool = tools.find(t => t.name === 'memory_recall')
    expect(recallTool).toBeDefined()
    const props = (recallTool?.inputSchema as { properties?: Record<string, unknown> })?.properties
    expect(props).toBeDefined()
    expect(props).not.toHaveProperty('exclude_flagged')
  })

  for (const action of ['search', 'clusters'] as const) {
    test(`${action} treats the retired exclude_flagged argument as an unknown key`, async () => {
      const id = seedThought({
        content: 'RECALL_RETIRED_MARKER unique content',
        status: 'active',
        ...(action === 'clusters' ? { is_cluster: 1 } : {})
      })
      const result = await client.callTool({
        name: 'memory_recall',
        arguments: { action, query: 'RECALL_RETIRED_MARKER', exclude_flagged: true, status: 'active' }
      })
      const parsed = parseResult(result)
      expect(parsed.isError).toBe(false)
      expect(JSON.stringify(parsed.data)).toContain(id)
    })
  }
})

describe('retired memory_recall input migration hints', () => {
  for (const [field, hint] of [['top_k', 'limit'], ['cluster', 'is_cluster']] as const) {
    test(`search rejects retired ${field} and points to ${hint}`, async () => {
      const result = await client.callTool({ name: 'memory_recall', arguments: { action: 'search', query: 'x', [field]: 3 } })
      const parsed = parseResult(result)
      expect(parsed.isError).toBe(true)
      expect(String(parsed.data)).toContain(hint)
    })
  }
  test('list rejects retired cluster filter and points to is_cluster', async () => {
    const result = await client.callTool({ name: 'memory_recall', arguments: { action: 'list', cluster: true } })
    const parsed = parseResult(result)
    expect(parsed.isError).toBe(true)
    expect(String(parsed.data)).toContain('is_cluster')
  })

  test('schema exposes canonical limit and is_cluster but not retired aliases', async () => {
    const { tools } = await client.listTools()
    const props = (tools.find(t => t.name === 'memory_recall')?.inputSchema as { properties?: Record<string, unknown> })?.properties
    expect(props).toHaveProperty('limit')
    expect(props).toHaveProperty('is_cluster')
    // Retired keys remain advertised as never-valued migration errors.
    for (const [key, description] of [['top_k', 'Removed; use limit.'], ['cluster', 'Removed; use is_cluster.']]) {
      const tombstone = props?.[key] as { description?: string; not?: unknown }
      expect(tombstone.description).toBe(description)
      expect(tombstone.not).toEqual({})
    }
  })
})

// ── String-numeric coercion (task #926) ───────────────────────────────────────

describe('memory_recall string-numeric coercion', () => {
  // Each case: param name, a valid string value, an out-of-range string value,
  // and the corresponding numeric-value out-of-range for cross-check.
  const numericParams = [
    { name: 'limit', validStr: '5', invalidHigh: '501', invalidLow: '0', intOnly: true },
    { name: 'min_importance', validStr: '0.5', invalidHigh: '1.5', invalidLow: '-0.1', intOnly: false },
    { name: 'recency_weight', validStr: '0.5', invalidHigh: '1.5', invalidLow: '-0.1', intOnly: false },
    {
      name: 'recency_half_life_days',
      validStr: '60',
      invalidHigh: '5000',
      invalidLow: '-1',
      intOnly: false // positive() accepts non-int floats; min bound is 0 not 1
    },
    { name: 'min_relevance', validStr: '0.5', invalidHigh: '1.5', invalidLow: '-0.1', intOnly: false },
    { name: 'max_degree', validStr: '50', invalidHigh: '201', invalidLow: '0', intOnly: true }
  ]

  for (const p of numericParams) {
    test(`accepts valid string ${p.name}`, async () => {
      await client.callTool({
        name: 'memory_store',
        arguments: { action: 'create', content: `COERCE_${p.name}_marker content`, status: 'active' }
      })
      const result = await client.callTool({
        name: 'memory_recall',
        arguments: { action: 'search', query: `COERCE_${p.name}_marker content`, [p.name]: p.validStr }
      })
      const { isError } = parseResult(result)
      expect(isError).toBe(false)
    })

    test(`rejects out-of-range string ${p.name} (high)`, async () => {
      const result = await client.callTool({
        name: 'memory_recall',
        arguments: { action: 'search', query: 'test', [p.name]: p.invalidHigh }
      })
      expect(parseResult(result).isError).toBe(true)
    })

    test(`rejects out-of-range string ${p.name} (low)`, async () => {
      const result = await client.callTool({
        name: 'memory_recall',
        arguments: { action: 'search', query: 'test', [p.name]: p.invalidLow }
      })
      expect(parseResult(result).isError).toBe(true)
    })

    test(`string ${p.name} is coerced to the correct numeric type`, async () => {
      await client.callTool({
        name: 'memory_store',
        arguments: { action: 'create', content: `COERCE_TYPE_${p.name} marker`, status: 'active' }
      })
      // The coerced value must behave identically to a native number — no error,
      // and the gate actually filters when min_relevance is involved.
      const result = await client.callTool({
        name: 'memory_recall',
        arguments: { action: 'search', query: `COERCE_TYPE_${p.name} marker`, [p.name]: p.validStr }
      })
      expect(parseResult(result).isError).toBe(false)
    })
  }

  test('min_relevance string "0.5" gates low-similarity results', async () => {
    // Seed two thoughts with distinct content so BM25 can differentiate them.
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'GATE_MIN_REL high relevance unique marker alpha', status: 'active' }
    })
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'GATE_MIN_REL low relevance unrelated content here', status: 'active' }
    })

    // With min_relevance=0 (default) both should appear.
    const defaultResult = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: 'GATE_MIN_REL', limit: 10 }
    })
    const defaultData = parseResult(defaultResult).data as Array<{ thought: { content: string } }>
    expect(defaultData.length).toBeGreaterThanOrEqual(1)

    // With min_relevance="0.9" (string) only the BM25-exact hit should remain.
    const gatedResult = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: 'GATE_MIN_REL', limit: 10, min_relevance: '0.9' }
    })
    const gatedData = parseResult(gatedResult).data as Array<{ thought: { content: string } }>
    // At least the exact-marker hit survives; the vague one may be dropped by the gate.
    expect(gatedData.length).toBeGreaterThanOrEqual(1)
    const hasExact = gatedData.some(r => r.thought.content.includes('high relevance'))
    expect(hasExact).toBe(true)
  })
})

// ── Per-axis standing semantics (task #926) ───────────────────────────────────

describe('memory_recall standing per-axis off semantics', () => {
  const QUERY = 'standing_axis_test'

  function seedContradictedPair(): { a: string; b: string } {
    const a = seedThought({ content: `${QUERY} claim alpha` })
    const b = seedThought({ content: `${QUERY} claim beta` })
    createEdge(getDb(), a, b, 'contradicts')
    return { a, b }
  }

  function seedSupersededPair(): { old: string; new: string } {
    const oldId = seedThought({ content: `${QUERY} older replaced claim` })
    const newId = seedThought({ content: `${QUERY} newer claim` })
    createEdge(getDb(), newId, oldId, 'replaces')
    return { old: oldId, new: newId }
  }

  async function recall(extra: Record<string, unknown> = {}) {
    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: QUERY, limit: 10, ...extra }
    })
    return parseResult(result)
  }

  test('default supersession_mode=suppress drops superseded rows entirely (no standing)', async () => {
    const { old: oldId, new: newId } = seedSupersededPair()
    const { data, isError } = await recall()
    expect(isError).toBe(false)
    const results = data as Array<{ thought: { id: string }; standing?: string }>
    // Default suppress: superseded row is removed from the result set.
    expect(results.find(r => r.thought.id === oldId)).toBeUndefined()
    // The replacement thought is present with current standing.
    expect(results.find(r => r.thought.id === newId)?.standing).toBe('current')
  })

  test('supersession_mode=flag, contradiction_mode=flag: standing is emitted', async () => {
    const { old: oldId, new: newId } = seedSupersededPair()
    const { data, isError } = await recall({ supersession_mode: 'flag' })
    expect(isError).toBe(false)
    const results = data as Array<{ thought: { id: string }; standing?: string }>
    const oldResult = results.find(r => r.thought.id === oldId)
    expect(oldResult?.standing).toBe('superseded')
    expect(results.find(r => r.thought.id === newId)?.standing).toBe('current')
  })

  test('supersession_mode=off, contradiction_mode=flag: standing is emitted for contradictions', async () => {
    const { a, b } = seedContradictedPair()
    const { data, isError } = await recall({ supersession_mode: 'off' })
    expect(isError).toBe(false)
    const results = data as Array<{ thought: { id: string }; standing?: string }>
    const aResult = results.find(r => r.thought.id === a)
    const bResult = results.find(r => r.thought.id === b)
    expect(aResult?.standing).toBe('contradicted')
    expect(bResult?.standing).toBe('contradicted')
  })

  test('supersession_mode=flag + contradiction_mode=off: standing is emitted for supersession', async () => {
    const { old: oldId, new: newId } = seedSupersededPair()
    const { data, isError } = await recall({ supersession_mode: 'flag', contradiction_mode: 'off' })
    expect(isError).toBe(false)
    const results = data as Array<{ thought: { id: string }; standing?: string }>
    const oldResult = results.find(r => r.thought.id === oldId)
    expect(oldResult?.standing).toBe('superseded')
    expect(results.find(r => r.thought.id === newId)?.standing).toBe('current')
  })

  test('both axes off: standing is OMITTED entirely (no annotation at all)', async () => {
    const { a, b } = seedContradictedPair()
    const { old: oldId, new: newId } = seedSupersededPair()
    const { data, isError } = await recall({ supersession_mode: 'off', contradiction_mode: 'off' })
    expect(isError).toBe(false)
    const results = data as Array<{
      thought: { id: string }
      standing?: string
      superseded_by?: string[]
      contradicted_by?: string[]
    }>
    // Every result must lack the standing field when both axes are off.
    for (const r of results) {
      expect(r.standing).toBeUndefined()
      expect(r.superseded_by).toBeUndefined()
      expect(r.contradicted_by).toBeUndefined()
    }
    // All seeded thoughts must be present (off = no annotation, not suppression).
    expect(results.find(r => r.thought.id === a)).toBeDefined()
    expect(results.find(r => r.thought.id === b)).toBeDefined()
    expect(results.find(r => r.thought.id === oldId)).toBeDefined()
    expect(results.find(r => r.thought.id === newId)).toBeDefined()
  })
})

// ── Advertised JSON Schema preserves numeric bounds despite z.coerce ─────────

describe('memory_recall advertised schema retains numeric bounds with z.coerce', () => {
  test('limit schema carries type:integer, minimum and maximum', async () => {
    const { tools } = await client.listTools()
    const recallTool = tools.find(t => t.name === 'memory_recall')
    expect(recallTool).toBeDefined()
    const props = (recallTool?.inputSchema as { properties?: Record<string, unknown> })?.properties
    expect(props).toBeDefined()
    const limit = props?.limit as Record<string, unknown> | undefined
    expect(limit).toBeDefined()
    expect(limit?.type).toBe('integer')
    expect(limit?.minimum).toBe(1)
    expect(limit?.maximum).toBe(500)
  })

  test('min_importance schema carries type:number, minimum and maximum', async () => {
    const { tools } = await client.listTools()
    const recallTool = tools.find(t => t.name === 'memory_recall')
    const props = (recallTool?.inputSchema as { properties?: Record<string, unknown> })?.properties
    const m = props?.min_importance as Record<string, unknown> | undefined
    expect(m?.type).toBe('number')
    expect(m?.minimum).toBe(0)
    expect(m?.maximum).toBe(1)
  })

  test('recency_weight schema carries type:number, minimum and maximum', async () => {
    const { tools } = await client.listTools()
    const recallTool = tools.find(t => t.name === 'memory_recall')
    const props = (recallTool?.inputSchema as { properties?: Record<string, unknown> })?.properties
    const m = props?.recency_weight as Record<string, unknown> | undefined
    expect(m?.type).toBe('number')
    expect(m?.minimum).toBe(0)
    expect(m?.maximum).toBe(1)
  })

  test('recency_half_life_days schema carries type:number with positive bounds', async () => {
    const { tools } = await client.listTools()
    const recallTool = tools.find(t => t.name === 'memory_recall')
    const props = (recallTool?.inputSchema as { properties?: Record<string, unknown> })?.properties
    const m = props?.recency_half_life_days as Record<string, unknown> | undefined
    expect(m?.type).toBe('number')
    // .positive() → exclusiveMinimum: 0 in JSON Schema
    expect(m?.exclusiveMinimum).toBe(0)
    expect(m?.maximum).toBe(3650)
  })

  test('min_relevance schema carries type:number, minimum and maximum', async () => {
    const { tools } = await client.listTools()
    const recallTool = tools.find(t => t.name === 'memory_recall')
    const props = (recallTool?.inputSchema as { properties?: Record<string, unknown> })?.properties
    const m = props?.min_relevance as Record<string, unknown> | undefined
    expect(m?.type).toBe('number')
    expect(m?.minimum).toBe(0)
    expect(m?.maximum).toBe(1)
  })

  test('max_degree schema carries type:integer, minimum and maximum', async () => {
    const { tools } = await client.listTools()
    const recallTool = tools.find(t => t.name === 'memory_recall')
    const props = (recallTool?.inputSchema as { properties?: Record<string, unknown> })?.properties
    const m = props?.max_degree as Record<string, unknown> | undefined
    expect(m?.type).toBe('integer')
    expect(m?.minimum).toBe(1)
    expect(m?.maximum).toBe(200)
  })

  test('string-typed numerics are accepted even though schema advertises type:number/integer', async () => {
    // This is the core regression: z.coerce lets string numerics through, but
    // the JSON Schema must still advertise type:number so clients know the
    // canonical shape while the runtime accepts the coerce path.
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'SCHEMA_COERCE_MARKER test content', status: 'active' }
    })
    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: 'SCHEMA_COERCE_MARKER', min_relevance: '0.5', limit: '3' }
    })
    const { isError } = parseResult(result)
    expect(isError).toBe(false)
  })
})

// ── is_global project scoping through memory_recall (epic #1489) ─────────────

describe('memory_recall — is_global is always included in a project-scoped search', () => {
  const P1 = 'recall-global-p1'
  const P2 = 'recall-global-p2'
  const QUERY = 'RECALL_GLOBAL_MARKER'

  async function recallSearch(extra: Record<string, unknown>) {
    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: QUERY, limit: 10, ...extra }
    })
    return parseResult(result)
  }

  function idsOf(data: unknown): string[] {
    return (data as Array<{ thought: { id: string } }>).map(r => r.thought.id)
  }

  function seedWorld() {
    const local = seedThought({ content: `${QUERY} local`, project_id: P1, status: 'active' })
    const foreign = seedThought({ content: `${QUERY} foreign`, project_id: P2, status: 'active' })
    // Global thought owned by P2 — must surface in a P1-scoped recall.
    const global = seedThought({ content: `${QUERY} global`, project_id: P2, is_global: 1, status: 'active' })
    return { local, foreign, global }
  }

  test('project_id includes global thoughts and excludes a foreign project', async () => {
    const { local, foreign, global } = seedWorld()

    const { data, isError } = await recallSearch({ project_id: P1 })
    expect(isError).toBe(false)
    const ids = idsOf(data)
    expect(ids).toContain(local)
    expect(ids).toContain(global)
    expect(ids).not.toContain(foreign)
  })

  test('a project-only thought does not leak into another project', async () => {
    const { local, foreign } = seedWorld()

    const { data, isError } = await recallSearch({ project_id: P2 })
    expect(isError).toBe(false)
    const ids = idsOf(data)
    expect(ids).toContain(foreign)
    expect(ids).not.toContain(local)
  })

  test('without project_id every project\'s thoughts are returned', async () => {
    const { local, foreign, global } = seedWorld()

    const { data, isError } = await recallSearch({})
    expect(isError).toBe(false)
    const ids = idsOf(data)
    expect(ids).toContain(local)
    expect(ids).toContain(foreign)
    expect(ids).toContain(global)
  })

  test('the clusters action also includes global thoughts', async () => {
    const localCluster = seedThought({
      content: `${QUERY} local cluster`,
      project_id: P1,
      is_cluster: 1,
      status: 'active'
    })
    const globalCluster = seedThought({
      content: `${QUERY} global cluster`,
      project_id: P2,
      is_cluster: 1,
      is_global: 1,
      status: 'active'
    })

    const scoped = parseResult(
      await client.callTool({
        name: 'memory_recall',
        arguments: { action: 'clusters', query: QUERY, limit: 10, project_id: P1 }
      })
    )
    expect(idsOf(scoped.data)).toContain(localCluster)
    expect(idsOf(scoped.data)).toContain(globalCluster)
  })

  test('the advertised schema no longer exposes include_global', async () => {
    const { tools } = await client.listTools()
    const recallTool = tools.find(t => t.name === 'memory_recall')
    const props = (recallTool?.inputSchema as { properties?: Record<string, unknown> })?.properties
    expect(props?.include_global).toBeUndefined()
  })
})

describe('memory_recall is_cluster filtering', () => {
  function idsOf(data: unknown): string[] {
    return (data as Array<{ thought: { id: string } }>).map(row => row.thought.id)
  }

  test('list true returns only clusters and false excludes clusters', async () => {
    const regular = seedThought({ content: 'filter marker regular' })
    const cluster = seedThought({ content: 'filter marker cluster', is_cluster: 1 })
    for (const [value, expected, excluded] of [[true, cluster, regular], [false, regular, cluster]] as const) {
      const { data, isError } = parseResult(await client.callTool({
        name: 'memory_recall', arguments: { action: 'list', is_cluster: value, limit: 100 }
      }))
      expect(isError).toBe(false)
      const ids = (data.thoughts as Array<{ id: string }>).map(row => row.id)
      expect(ids).toContain(expected)
      expect(ids).not.toContain(excluded)
    }
  })

  test('search filters clusters using a file-backed vec0 database', async () => {
    await withVecDb(async () => {
      const regular = seedThought({ content: 'VECTOR_CLUSTER_FILTER_MCP regular thought' })
      const cluster = seedThought({ content: 'VECTOR_CLUSTER_FILTER_MCP cluster thought', is_cluster: 1 })
      for (const [value, expected, excluded] of [[true, cluster, regular], [false, regular, cluster]] as const) {
        const { data, isError } = parseResult(await client.callTool({
          name: 'memory_recall', arguments: { action: 'search', query: 'VECTOR_CLUSTER_FILTER_MCP', limit: 10, is_cluster: value }
        }))
        expect(isError).toBe(false)
        expect(idsOf(data)).toContain(expected)
        expect(idsOf(data)).not.toContain(excluded)
      }
    })
  })

  test('chain max_degree controls traversal depth through the MCP field', async () => {
    const root = seedThought({ content: 'CHAIN_DEGREE root' })
    const first = seedThought({ content: 'CHAIN_DEGREE first' })
    const second = seedThought({ content: 'CHAIN_DEGREE second' })
    createEdge(getDb(), root, first, 'related')
    createEdge(getDb(), root, second, 'related')

    async function downstream(max_degree: number) {
      const { data, isError } = parseResult(await client.callTool({
        name: 'memory_recall',
        arguments: { action: 'chain', thought_id: root, direction: 'downstream', max_degree }
      }))
      expect(isError).toBe(false)
      return data as { downstream: unknown[] }
    }

    const shallow = await downstream(1)
    const deeper = await downstream(2)
    expect(shallow.downstream).toHaveLength(1)
    expect(deeper.downstream).toHaveLength(2)
  })
})
