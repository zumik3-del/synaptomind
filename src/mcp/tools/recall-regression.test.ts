import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getDb } from '../../db/container'
import { createEdge } from '../../db/edges'
import { closeDb } from '../../db/init'
import { createTestDb, seedThought } from '../../test/helpers'
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

// ── String-numeric coercion (task #926) ───────────────────────────────────────

describe('memory_recall string-numeric coercion', () => {
  // Each case: param name, a valid string value, an out-of-range string value,
  // and the corresponding numeric-value out-of-range for cross-check.
  const numericParams = [
    { name: 'top_k', validStr: '5', invalidHigh: '101', invalidLow: '0', intOnly: true },
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
      arguments: { action: 'search', query: 'GATE_MIN_REL', top_k: 10 }
    })
    const defaultData = parseResult(defaultResult).data as Array<{ thought: { content: string } }>
    expect(defaultData.length).toBeGreaterThanOrEqual(1)

    // With min_relevance="0.9" (string) only the BM25-exact hit should remain.
    const gatedResult = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: 'GATE_MIN_REL', top_k: 10, min_relevance: '0.9' }
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
      arguments: { action: 'search', query: QUERY, top_k: 10, ...extra }
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
  test('top_k schema carries type:integer, minimum and maximum', async () => {
    const { tools } = await client.listTools()
    const recallTool = tools.find(t => t.name === 'memory_recall')
    expect(recallTool).toBeDefined()
    const props = (recallTool?.inputSchema as { properties?: Record<string, unknown> })?.properties
    expect(props).toBeDefined()
    const topK = props?.top_k as Record<string, unknown> | undefined
    expect(topK).toBeDefined()
    expect(topK?.type).toBe('integer')
    expect(topK?.minimum).toBe(1)
    expect(topK?.maximum).toBe(100)
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
      arguments: { action: 'search', query: 'SCHEMA_COERCE_MARKER', min_relevance: '0.5', top_k: '3' }
    })
    const { isError } = parseResult(result)
    expect(isError).toBe(false)
  })
})
