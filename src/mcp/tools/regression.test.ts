import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { closeDb } from '../../db/init'
import { createTestDb } from '../../test/helpers'
import { registerAllMemoryTools } from '.'
import { jsonResult } from './utils'

// Regression coverage for the MCP stdio/dispatch batch (tasks #127-#134):
// cleanup dry-run default, numeric schema bounds, context project scoping and
// structured output mirroring. Mirrors the setup style of tools.test.ts.

mock.module('../../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: () => [new Float32Array(384)],
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

let client: Client

// A fresh test DB registers no project for this path, so read-side calls keep
// the global scope while satisfying the hard-cwd contract of task #2179.
const UNSCOPED_CWD = '/tmp/mcp-unscoped'

/** Actions that require `cwd`; `callTool` injects the default for them. */
const CWD_ACTIONS: Record<string, string[]> = {
  memory_recall: ['search', 'clusters', 'list', 'context'],
  memory_status: ['slots', 'frontier', 'propose'],
  memory_reflect: ['reflect', 'timeline'],
  memory_primers: ['list'],
  memory_manage: ['list', 'create', 'update', 'delete', 'resolve']
}

/** `client.callTool` with the hard-cwd default injected for the scoped actions. */
function callTool(request: { name: string; arguments?: Record<string, unknown> }) {
  const args = request.arguments ?? {}
  const scoped = CWD_ACTIONS[request.name]
  const needsCwd = scoped?.includes(String(args.action)) === true
  return client.callTool({ ...request, arguments: needsCwd ? { cwd: UNSCOPED_CWD, ...args } : args } as Parameters<Client['callTool']>[0])
}

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

type ToolResult = {
  content: Array<{ type: string; text: string }>
  structuredContent?: { result?: unknown }
  isError?: boolean
}

function assertStructuredMatchesText(result: unknown): void {
  const r = result as ToolResult
  expect(r.isError).not.toBe(true)
  expect(r.structuredContent).toBeDefined()
  const text = r.content[0].text
  let expected: unknown
  try {
    expected = JSON.parse(text)
  } catch {
    // Non-JSON (raw text) payloads are wrapped as { text } by #2126.
    expected = { text }
  }
  expect(r.structuredContent?.result).toEqual(expected)
}

beforeEach(createTestDb)
afterEach(closeDb)

beforeAll(async () => {
  client = await setupClient()
})

// ── Numeric schema validation ───────────────────────────────────────────────

const invalidNumericCases: Array<{ label: string; name: string; args: Record<string, unknown>; param: string }> = [
  { label: 'negative limit', name: 'memory_recall', args: { action: 'search', query: 'x', limit: -1 }, param: 'limit' },
  { label: 'non-integer limit', name: 'memory_recall', args: { action: 'search', query: 'x', limit: 1.5 }, param: 'limit' },
  { label: 'zero limit', name: 'memory_recall', args: { action: 'search', query: 'x', limit: 0 }, param: 'limit' },
  { label: 'negative max_degree', name: 'memory_recall', args: { action: 'chain', thought_id: 'x', max_degree: -2 }, param: 'max_degree' },
  { label: 'non-integer max_degree', name: 'memory_recall', args: { action: 'context', query: 'x', max_degree: 2.5 }, param: 'max_degree' },
  { label: 'negative timeline limit', name: 'memory_reflect', args: { action: 'timeline', limit: -5 }, param: 'limit' },
  { label: 'non-integer timeline limit', name: 'memory_reflect', args: { action: 'timeline', limit: 1.5 }, param: 'limit' },
  { label: 'negative graph limit', name: 'memory_crystallize', args: { action: 'graph', limit: -1 }, param: 'limit' },
  { label: 'negative frontier k', name: 'memory_status', args: { action: 'frontier', k: -3 }, param: 'k' }
]

describe('numeric parameter schema validation', () => {
  for (const c of invalidNumericCases) {
    test(`rejects ${c.label} on ${c.name}`, async () => {
      const result = await callTool({ name: c.name, arguments: c.args })
      const { data, isError } = parseResult(result)

      expect(isError).toBe(true)
      expect(String(data)).toContain('Invalid arguments')
      expect(String(data)).toContain(c.param)
    })
  }

  test('rejects min_importance above 1', async () => {
    const result = await callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: 'x', min_importance: 1.5 }
    })
    const { data, isError } = parseResult(result)

    expect(isError).toBe(true)
    expect(String(data)).toContain('Invalid arguments')
    expect(String(data)).toContain('min_importance')
  })
})

// ── Shared request contract parity (task #1758, audit M8) ───────────────────
//
// `src/validation.ts` declares the status enum and limit ranges once; both the
// HTTP adapters and these MCP tool input schemas import them, so the two
// surfaces can never drift. Red-proof: on the pre-#1758 code `memory_crystallize`
// advertised `status` as an open string (accepting `bogus`) and the limits were
// inlined literals.

describe('shared request contract parity (audit M8)', () => {
  async function inputSchemaOf(name: string): Promise<Record<string, any>> {
    const { tools } = await client.listTools()
    const tool = tools.find(t => t.name === name)
    expect(tool).toBeDefined()
    return tool!.inputSchema as Record<string, any>
  }

  test('memory_crystallize advertises the shared graph status enum', async () => {
    const schema = await inputSchemaOf('memory_crystallize')
    expect(schema.properties.status.enum).toEqual(['active', 'draft', 'archived', 'all'])
    expect(schema.properties.limit.minimum).toBe(1)
    expect(schema.properties.limit.maximum).toBe(2000)
  })

  test('memory_status advertises precise retired-parameter tombstones', async () => {
    const schema = await inputSchemaOf('memory_status')
    for (const [key, description] of [['k', 'Removed; use limit.']]) {
      expect(schema.properties[key].description).toBe(description)
      expect(schema.properties[key].not).toEqual({})
    }
  })

  test('memory_crystallize advertises the retired preview-flag tombstone', async () => {
    const schema = await inputSchemaOf('memory_crystallize')
    expect(schema.properties.dry_run.description).toBe('Removed; use confirm.')
    expect(schema.properties.dry_run.not).toEqual({})
  })

  test('memory_reflect advertises the shared timeline limit range', async () => {
    const schema = await inputSchemaOf('memory_reflect')
    expect(schema.properties.limit.minimum).toBe(1)
    expect(schema.properties.limit.maximum).toBe(500)
    expect(schema.properties.status.enum).toEqual(['draft', 'active', 'archived'])
  })

  test('memory_crystallize graph rejects an out-of-enum status', async () => {
    const result = await callTool({
      name: 'memory_crystallize',
      arguments: { action: 'graph', status: 'bogus' }
    })
    const { data, isError } = parseResult(result)

    expect(isError).toBe(true)
    expect(String(data)).toContain('status')
  })

  test('memory_crystallize graph rejects a limit above 2000', async () => {
    const result = await callTool({
      name: 'memory_crystallize',
      arguments: { action: 'graph', limit: 2001 }
    })
    const { data, isError } = parseResult(result)

    expect(isError).toBe(true)
    expect(String(data)).toContain('limit')
  })

  test('memory_crystallize graph rejects an out-of-range offset', async () => {
    // The offset bound (0..1_000_000) used to be pinned by the deleted
    // `GET /api/graph` contract test (ADR 2026-10-26); it now lives here, at the
    // MCP action that shares `graphOffsetSchema`.
    for (const offset of [-1, 1_000_001]) {
      const { data, isError } = parseResult(
        await callTool({ name: 'memory_crystallize', arguments: { action: 'graph', offset } })
      )
      expect({ offset, isError }).toEqual({ offset, isError: true })
      expect(String(data)).toContain('offset')
    }

    const ok = parseResult(await callTool({ name: 'memory_crystallize', arguments: { action: 'graph', offset: 0 } }))
    expect(ok.isError).toBe(false)
  })

  test('memory_reflect timeline rejects a limit above 500 but accepts 500', async () => {
    const over = await callTool({
      name: 'memory_reflect',
      arguments: { action: 'timeline', limit: 501 }
    })
    expect(parseResult(over).isError).toBe(true)

    const atMax = await callTool({
      name: 'memory_reflect',
      arguments: { action: 'timeline', limit: 500 }
    })
    expect(parseResult(atMax).isError).toBe(false)
  })

  test('memory_reflect timeline coerces a numeric-string limit (shared coerce schema)', async () => {
    // The old inline schema was a bare `z.number()`; the shared
    // `timelineLimitSchema` coerces, matching the HTTP query-string path.
    const result = await callTool({
      name: 'memory_reflect',
      arguments: { action: 'timeline', limit: '50' }
    })
    expect(parseResult(result).isError).toBe(false)
  })
})

// ── memory_recall context project scoping ───────────────────────────────────

describe('memory_recall context honors project_id', () => {
  const MARKER = 'CONTEXT_SCOPE_MARKER'

  test('returns a degraded result when the matching thought is outside the requested project', async () => {
    // Marker exists only in the default project.
    await callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: `${MARKER} lives in the default project`, status: 'active' }
    })

    const proj = await callTool({
      name: 'memory_manage',
      arguments: { action: 'create', name: 'ContextScopeEmpty', local_path: '/tmp/context-scope-empty' }
    })
    parseResult(proj)

    const result = await callTool({
      name: 'memory_recall',
      arguments: { action: 'context', query: MARKER, cwd: '/tmp/context-scope-empty', compact: false }
    })
    const { data, isError } = parseResult(result)

    // Scoped search found nothing in that project — it must not fall back to
    // the matching thought in the default project. The new contract surfaces
    // degradation instead of throwing NotFoundError.
    expect(isError).toBe(false)
    expect(data.item).toBeNull()
    expect(data.meta.degraded).toBe(true)
    expect(data.meta.reason).toBe('no_match')
  })

  test('scopes the best match to the requested project', async () => {
    const proj = await callTool({
      name: 'memory_manage',
      arguments: { action: 'create', name: 'ContextScopeHit', local_path: '/tmp/context-scope-hit' }
    })
    const { data: project } = parseResult(proj)

    // Same marker in both projects: the scoped call must select the in-project one.
    await callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: `${MARKER} global decoy`, status: 'active' }
    })
    await callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: `${MARKER} inside target`, status: 'active', cwd: '/tmp/context-scope-hit' }
    })

    const result = await callTool({
      name: 'memory_recall',
      arguments: { action: 'context', query: MARKER, cwd: '/tmp/context-scope-hit', compact: false }
    })
    const { data, isError } = parseResult(result)

    expect(isError).toBe(false)
    expect(data.item.thought.project_id).toBe(project.item.id)
  })
})

// ── Structured outputs mirror the text payload ──────────────────────────────

describe('structuredContent mirrors the text payload', () => {
  test('memory_recall search', async () => {
    await callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'structured recall marker', status: 'active' }
    })
    const result = await callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: 'structured recall marker', limit: 5 }
    })
    assertStructuredMatchesText(result)
  })

  test('memory_status slots', async () => {
    const result = await callTool({ name: 'memory_status', arguments: { action: 'slots' } })
    assertStructuredMatchesText(result)
  })

  test('memory_status config (raw-text payload inside the envelope)', async () => {
    const result = await callTool({ name: 'memory_status', arguments: { action: 'config' } }) as ToolResult
    // The content channel stays raw text; the structured channel carries the
    // shared envelope with the same text in `item.text`.
    expect(result.isError).not.toBe(true)
    const envelope = result.structuredContent?.result as { item: { text: string }; meta: { action: string } }
    expect(envelope.item.text).toBe(result.content[0].text)
    expect(envelope.meta.action).toBe('config')
  })

  test('memory_manage list', async () => {
    const result = await callTool({ name: 'memory_manage', arguments: { action: 'list' } })
    assertStructuredMatchesText(result)
  })

  test('memory_guide (non-JSON text payload)', async () => {
    const result = await callTool({ name: 'memory_guide', arguments: {} })
    assertStructuredMatchesText(result)
  })

  test('every registered tool advertises the shared output envelope', async () => {
    const { tools } = await client.listTools()
    expect(tools.length).toBe(11)
    for (const tool of tools) {
      const outputSchema = tool.outputSchema as { required?: string[]; properties?: Record<string, unknown> } | undefined
      expect(outputSchema).toBeDefined()
      expect(outputSchema?.required).toContain('result')
      expect(Object.keys(outputSchema?.properties ?? {})).toEqual(['result'])
    }
  })
})

// ── No bare-string tool results (#2135 AC-3) ───────────────────────────────

describe('no bare-string tool results (#2135)', () => {
  test('jsonResult wraps a bare string to { text }', () => {
    // Re-asserted here (also in utils.test.ts) so the runtime invariant is
    // visible alongside the per-tool loop below.
    const result = jsonResult('x')
    expect(result.structuredContent.result).toEqual({ text: 'x' })
    expect(typeof result.structuredContent.result).not.toBe('string')
  })

  test('representative tool calls never return a bare string in result', async () => {
    const created = parseResult(await callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'no-bare-string probe' }
    }))
    const thoughtId = created.data.id as string

    const cases: Array<{ label: string; call: () => Promise<unknown> }> = [
      { label: 'memory_store create', call: () => callTool({ name: 'memory_store', arguments: { action: 'create', content: 'x' } }) },
      { label: 'memory_recall search', call: () => callTool({ name: 'memory_recall', arguments: { action: 'search', query: 'x' } }) },
      { label: 'memory_manage list', call: () => callTool({ name: 'memory_manage', arguments: { action: 'list' } }) },
      { label: 'memory_primers list', call: () => callTool({ name: 'memory_primers', arguments: { action: 'list' } }) },
      { label: 'memory_reflect timeline', call: () => callTool({ name: 'memory_reflect', arguments: { action: 'timeline' } }) },
      { label: 'memory_crystallize graph', call: () => callTool({ name: 'memory_crystallize', arguments: { action: 'graph' } }) },
      { label: 'memory_status slots', call: () => callTool({ name: 'memory_status', arguments: { action: 'slots' } }) },
      { label: 'memory_status config', call: () => callTool({ name: 'memory_status', arguments: { action: 'config' } }) },
      { label: 'edge_review list', call: () => callTool({ name: 'edge_review', arguments: { action: 'list' } }) },
      { label: 'retention_review list', call: () => callTool({ name: 'retention_review', arguments: { action: 'list' } }) },
      { label: 'memory_guide', call: () => callTool({ name: 'memory_guide', arguments: {} }) },
      { label: 'memory_supersede archive', call: () => callTool({ name: 'memory_supersede', arguments: { action: 'archive', thought_id: thoughtId, confirm: true } }) },
    ]

    for (const c of cases) {
      const result = await c.call()
      const r = result as { structuredContent?: { result?: unknown }; isError?: boolean }
      if (r.structuredContent !== undefined) {
        expect(typeof r.structuredContent.result).not.toBe('string')
      }
    }
  })
})
