import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { closeDb, getDb } from '../../db'
import type { PlacementProposalRow } from '../../db/placement-proposals'
import { createTestDb, seedThought } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

mock.module('../../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: (texts: string[]) => texts.map(() => new Float32Array(384)),
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

const COUNTS_SOURCE = 'counts-src'
const BASE = Date.parse('2026-01-01T00:00:00.000Z')
const LAPSED = '2000-01-01T00:00:00.000Z'

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

function parseResult(result: unknown): { data: any; isError: boolean; text: string } {
  const r = result as { content: Array<{ type: string; text: string }>; isError?: boolean }
  const text = r.content?.[0]?.text ?? '{}'
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { data: parsed, isError: r.isError === true, text }
}

interface QueueFixture {
  /** Unexpired `edge` rows, oldest of the fixture. */
  live?: number
  /** Unexpired retired `triage_activate` rows, newer than the live ones. */
  retired?: number
  /** Pending `edge` rows past their TTL, newest of the fixture. */
  lapsed?: number
}

/**
 * One transaction for the whole queue: a 1200-row page test must not spend its budget on
 * per-row helpers. Retired rows sit above the live ones and lapsed rows above both, so a
 * newest-first scan that ignores the filters hits exactly the rows that expose it.
 */
function seedQueue(fixture: QueueFixture = {}): void {
  const { live = 0, retired = 0, lapsed = 0 } = fixture
  const db = getDb()
  seedThought({ id: COUNTS_SOURCE, content: 'counting queue source' })

  const insertThought = db.prepare(`
    INSERT INTO thoughts (id, content, status, source, project_id, is_cluster, is_protected, is_global, created_at, updated_at)
    VALUES (?, 'counting queue target', 'active', 'test', 'default', 0, 1, 0, ?, ?)
  `)
  const insertRow = db.prepare(`
    INSERT INTO placement_proposals
      (id, project_id, source_thought_id, item_kind, target_id, edge_type, lifecycle_action, direction,
       confidence, rationale, rule_id, payload, fingerprint, state, created_at, expires_at)
    VALUES (?, 'default', ?, ?, ?, ?, null, 'symmetric', 0.8, 'counting queue row', null, '{}', ?, 'pending', ?, ?)
  `)
  const stamp = (index: number): string => new Date(BASE + index * 1000).toISOString()

  const row = (kind: string, index: number, expiresAt: string | null): void => {
    const targetId = `counts-${kind}-${index}`
    const at = stamp(index)
    insertThought.run(targetId, at, at)
    insertRow.run(
      `counts-${kind}-row-${index}`,
      COUNTS_SOURCE,
      kind === 'lapsed' ? 'edge' : kind,
      targetId,
      kind === 'triage_activate' ? null : 'related',
      `fp-${kind}-${index}`,
      at,
      expiresAt
    )
  }

  db.transaction(() => {
    for (let i = 0; i < live; i++) row('edge', i, null)
    for (let i = 0; i < retired; i++) row('triage_activate', live + i, null)
    for (let i = 0; i < lapsed; i++) row('lapsed', live + retired + i, LAPSED)
  })()
}

async function list(
  args: Record<string, unknown> = {}
): Promise<{ items: PlacementProposalRow[]; counts: Record<string, number> }> {
  const result = await client.callTool({
    name: 'edge_review',
    arguments: { action: 'list', ...args }
  })
  const { data, isError } = parseResult(result)
  expect(isError).toBe(false)
  return { items: data.items as PlacementProposalRow[], counts: data.meta.counts }
}

function accounting(counts: Record<string, number>): {
  returned: number
  filtered_out: number
  total: number
} {
  return {
    returned: counts.returned,
    filtered_out: counts.filtered_out,
    total: counts.total
  }
}

beforeEach(createTestDb)
afterEach(() => {
  closeDb()
})

beforeAll(async () => {
  client = await setupClient()
})

describe('edge_review list counts: the total is un-paged', () => {
  test('1200 unexpired rows plus 3 retired: total 1200, page 100, filtered_out 1100, retired_count 3', async () => {
    seedQueue({ live: 1200, retired: 3 })

    const { items, counts } = await list({ limit: 100 })

    expect(items).toHaveLength(100)
    expect(accounting(counts)).toEqual({ returned: 100, filtered_out: 1100, total: 1200 })
    expect(counts.retired_count).toBe(3)
  })

  test('include_retired folds the 3 retired rows into the same un-paged total', async () => {
    seedQueue({ live: 1200, retired: 3 })

    const { items, counts } = await list({ limit: 100, include_retired: true })

    expect(items).toHaveLength(100)
    expect(accounting(counts)).toEqual({ returned: 100, filtered_out: 1103, total: 1203 })
    expect(counts.retired_count).toBe(0)
  })

  test('an explicit item_kind filters and counts the same way, retired kind included', async () => {
    seedQueue({ live: 1200, retired: 3 })

    const edges = await list({ item_kind: 'edge', limit: 100 })
    expect(edges.items).toHaveLength(100)
    expect(accounting(edges.counts)).toEqual({ returned: 100, filtered_out: 1100, total: 1200 })
    expect(edges.counts.retired_count).toBe(0)

    const retired = await list({ item_kind: 'triage_activate', limit: 100 })
    expect(retired.items).toHaveLength(3)
    expect(retired.items.every(row => row.item_kind === 'triage_activate')).toBe(true)
    expect(accounting(retired.counts)).toEqual({ returned: 3, filtered_out: 0, total: 3 })
    expect(retired.counts.retired_count).toBe(0)
  })

  test('the default page is the 100 the limit description advertises', async () => {
    seedQueue({ live: 1200 })

    const { items, counts } = await list()

    expect(items).toHaveLength(100)
    expect(accounting(counts)).toEqual({ returned: 100, filtered_out: 1100, total: 1200 })
  })
})

describe('edge_review list counts: an expired row never consumes a page slot', () => {
  test('the newest rows are expired: the page is still full and the three keys add up', async () => {
    seedQueue({ live: 7, lapsed: 3 })

    const { items, counts } = await list({ limit: 5 })

    expect(items).toHaveLength(5)
    expect(items.some(row => row.expires_at === LAPSED)).toBe(false)
    expect(accounting(counts)).toEqual({ returned: 5, filtered_out: 2, total: 7 })
    expect(counts.returned + counts.filtered_out).toBe(counts.total)
    expect(counts.retired_count).toBe(0)
  })

  test('a limit above the row count returns every live row and leaves filtered_out at 0', async () => {
    seedQueue({ live: 7, lapsed: 3 })

    const { items, counts } = await list({ limit: 100 })

    expect(items).toHaveLength(7)
    expect(accounting(counts)).toEqual({ returned: 7, filtered_out: 0, total: 7 })
    expect(counts.returned + counts.filtered_out).toBe(counts.total)
  })
})

describe('edge_review list: docs and tool description match the asserted contract', () => {
  function flatten(text: string): string {
    return text.replace(/\s+/g, ' ')
  }

  test('docs/mcp-tools.md states the page/count contract these tests assert', () => {
    const doc = flatten(
      readFileSync(new URL('../../../docs/mcp-tools.md', import.meta.url), 'utf8')
    )

    expect(doc).toContain(
      '| `edge_review` `list` | the un-paged row count matching the filters, retired kinds excluded unless `include_retired` | the rows the page `limit` left out |'
    )
    expect(doc).toContain(
      'Page and count run the same predicates in SQL (pending liveness and the retired-kind exclusion included), so `returned + filtered_out = total` always holds and a page is short only when fewer rows match.'
    )
    expect(doc).toContain(
      '`meta.counts.total` is that un-paged `COUNT(*)`, so it never stops at the page cap'
    )
    expect(doc).toContain(
      '`meta.counts.retired_count` is the retired (legacy) rows the default filter hid, which sit in neither `total` nor `filtered_out`'
    )
    expect(doc).toContain(
      '`memory_crystallize` `graph` and `edge_review` `list` — and it fails for the rest'
    )
  })

  test('the edge_review description states the counting rule the handler enforces', async () => {
    const { tools } = await client.listTools()
    const tool = tools.find(entry => entry.name === 'edge_review')
    expect(tool).toBeDefined()
    expect(tool?.description).toContain('page and counts.total apply the same filters in SQL')
    expect(tool?.description).toContain('counts.total is the un-paged row count')
    expect(tool?.description).toContain('counts.filtered_out the rows the page limit left out')
    expect(tool?.description).toContain(
      'counts.retired_count the retired rows the default filter hid'
    )

    const properties = (tool?.inputSchema.properties ?? {}) as Record<
      string,
      { description?: string }
    >
    expect(properties.limit?.description).toContain('default 100, 1-1000')
    expect(properties.include_retired?.description).toContain('Default false')
    expect(properties.state?.description).toContain('default pending')
  })
})
