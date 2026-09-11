import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { closeDb } from '../../db/init'
import { getDb } from '../../db/container'
import { createTestDb, seedThought } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

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
    expected = text
  }
  expect(r.structuredContent?.result).toEqual(expected)
}

/** Seed an archived thought whose retention age exceeds the TTL (default 90d). */
function seedExpiredArchived(): string {
  const d = getDb()
  const id = seedThought({ status: 'active', is_protected: 0 })
  const archivedAt = new Date(Date.now() - 100 * 86400000).toISOString()
  d.prepare(`UPDATE thoughts SET status = 'archived', archived_at = ? WHERE id = ?`).run(archivedAt, id)
  return id
}

function thoughtExists(id: string): boolean {
  return getDb().prepare(`SELECT id FROM thoughts WHERE id = ?`).get(id) != null
}

beforeEach(createTestDb)
afterEach(closeDb)

beforeAll(async () => {
  client = await setupClient()
})

// ── memory_status cleanup: dry-run is the default ───────────────────────────

describe('memory_status cleanup dry-run default', () => {
  test('cleanup without dry_run previews and does not delete', async () => {
    const id = seedExpiredArchived()

    const result = await client.callTool({ name: 'memory_status', arguments: { action: 'cleanup' } })
    const { data, isError } = parseResult(result)

    expect(isError).toBe(false)
    expect(data.deleted).toBeGreaterThanOrEqual(1)
    expect(data.ids).toContain(id)
    // Preview only: the archived thought is still present.
    expect(thoughtExists(id)).toBe(true)
  })

  test('cleanup with dry_run=true previews and does not delete', async () => {
    const id = seedExpiredArchived()

    const result = await client.callTool({
      name: 'memory_status',
      arguments: { action: 'cleanup', dry_run: true }
    })
    const { data, isError } = parseResult(result)

    expect(isError).toBe(false)
    expect(data.deleted).toBeGreaterThanOrEqual(1)
    expect(thoughtExists(id)).toBe(true)
  })

  test('cleanup with dry_run=false deletes the expired thought', async () => {
    const id = seedExpiredArchived()

    const result = await client.callTool({
      name: 'memory_status',
      arguments: { action: 'cleanup', dry_run: false }
    })
    const { data, isError } = parseResult(result)

    expect(isError).toBe(false)
    expect(data.deleted).toBeGreaterThanOrEqual(1)
    expect(data.ids).toContain(id)
    expect(thoughtExists(id)).toBe(false)
  })
})

// ── Numeric schema validation ───────────────────────────────────────────────

const invalidNumericCases: Array<{ label: string; name: string; args: Record<string, unknown>; param: string }> = [
  { label: 'negative top_k', name: 'memory_recall', args: { action: 'search', query: 'x', top_k: -1 }, param: 'top_k' },
  { label: 'non-integer top_k', name: 'memory_recall', args: { action: 'search', query: 'x', top_k: 1.5 }, param: 'top_k' },
  { label: 'zero top_k', name: 'memory_recall', args: { action: 'search', query: 'x', top_k: 0 }, param: 'top_k' },
  { label: 'negative max_degree', name: 'memory_recall', args: { action: 'chain', thought_id: 'x', max_degree: -2 }, param: 'max_degree' },
  { label: 'non-integer max_degree', name: 'memory_recall', args: { action: 'context', query: 'x', max_degree: 2.5 }, param: 'max_degree' },
  { label: 'negative timeline limit', name: 'memory_reflect', args: { action: 'timeline', limit: -5 }, param: 'limit' },
  { label: 'non-integer timeline limit', name: 'memory_reflect', args: { action: 'timeline', limit: 1.5 }, param: 'limit' },
  { label: 'negative telemetry limit', name: 'memory_telemetry', args: { action: 'query', metric: 'patterns', limit: -1 }, param: 'limit' },
  { label: 'negative graph limit', name: 'memory_crystallize', args: { action: 'graph', limit: -1 }, param: 'limit' },
  { label: 'negative frontier k', name: 'memory_status', args: { action: 'frontier', k: -3 }, param: 'k' }
]

describe('numeric parameter schema validation', () => {
  for (const c of invalidNumericCases) {
    test(`rejects ${c.label} on ${c.name}`, async () => {
      const result = await client.callTool({ name: c.name, arguments: c.args })
      const { data, isError } = parseResult(result)

      expect(isError).toBe(true)
      expect(String(data)).toContain('Invalid arguments')
      expect(String(data)).toContain(c.param)
    })
  }

  test('rejects min_importance above 1', async () => {
    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: 'x', min_importance: 1.5 }
    })
    const { data, isError } = parseResult(result)

    expect(isError).toBe(true)
    expect(String(data)).toContain('Invalid arguments')
    expect(String(data)).toContain('min_importance')
  })
})

// ── memory_recall context project scoping ───────────────────────────────────

describe('memory_recall context honors project_id', () => {
  const MARKER = 'CONTEXT_SCOPE_MARKER'

  test('returns error when the matching thought is outside the requested project', async () => {
    // Marker exists only in the default project.
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: `${MARKER} lives in the default project`, status: 'active' }
    })

    const proj = await client.callTool({
      name: 'memory_manage',
      arguments: { action: 'create', name: 'ContextScopeEmpty', local_path: '/tmp/context-scope-empty' }
    })
    const { data: project } = parseResult(proj)

    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'context', query: MARKER, project_id: project.id }
    })
    const { isError } = parseResult(result)

    // Scoped search found nothing in that project — it must not fall back to
    // the matching thought in the default project.
    expect(isError).toBe(true)
  })

  test('scopes the best match to the requested project', async () => {
    const proj = await client.callTool({
      name: 'memory_manage',
      arguments: { action: 'create', name: 'ContextScopeHit', local_path: '/tmp/context-scope-hit' }
    })
    const { data: project } = parseResult(proj)

    // Same marker in both projects: the scoped call must select the in-project one.
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: `${MARKER} global decoy`, status: 'active' }
    })
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: `${MARKER} inside target`, status: 'active', project_id: project.id }
    })

    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'context', query: MARKER, project_id: project.id }
    })
    const { data, isError } = parseResult(result)

    expect(isError).toBe(false)
    expect(data.best_match.project_id).toBe(project.id)
  })
})

// ── Structured outputs mirror the text payload ──────────────────────────────

describe('structuredContent mirrors the text payload', () => {
  test('memory_recall search', async () => {
    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'structured recall marker', status: 'active' }
    })
    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: 'structured recall marker', top_k: 5 }
    })
    assertStructuredMatchesText(result)
  })

  test('memory_status slots', async () => {
    const result = await client.callTool({ name: 'memory_status', arguments: { action: 'slots' } })
    assertStructuredMatchesText(result)
  })

  test('memory_status config (non-JSON text payload)', async () => {
    const result = await client.callTool({ name: 'memory_status', arguments: { action: 'config' } })
    assertStructuredMatchesText(result)
  })

  test('memory_manage list', async () => {
    const result = await client.callTool({ name: 'memory_manage', arguments: { action: 'list' } })
    assertStructuredMatchesText(result)
  })

  test('memory_guide (non-JSON text payload)', async () => {
    const result = await client.callTool({ name: 'memory_guide', arguments: {} })
    assertStructuredMatchesText(result)
  })

  test('every registered tool advertises the shared output envelope', async () => {
    const { tools } = await client.listTools()
    expect(tools.length).toBe(9)
    for (const tool of tools) {
      const outputSchema = tool.outputSchema as { required?: string[]; properties?: Record<string, unknown> } | undefined
      expect(outputSchema).toBeDefined()
      expect(outputSchema?.required).toContain('result')
      expect(Object.keys(outputSchema?.properties ?? {})).toEqual(['result'])
    }
  })
})
