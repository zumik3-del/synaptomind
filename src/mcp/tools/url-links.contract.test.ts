import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as thoughtUrlLinksDb from '../../db/thought_url_links'
import { upsertThoughtUrlLink } from '../../db/thought_url_links'
import { getDb } from '../../db/container'
import { createEdge } from '../../db/edges'
import { closeDb } from '../../db/init'
import { createTestDb, seedThought } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

/**
 * `include_url_links` contract (ADR 2026-10-26 §4, task #2202).
 *
 * The removed `GET /api/thoughts/:id/links` and `/links/batch` read surfaces
 * moved into the MCP thought output behind one boolean argument. This file pins
 * the four rules that make the move safe:
 *
 *   1. absence is the default — the key is absent, not `[]`, unless asked;
 *   2. `true` with no links answers `[]` ("asked, there are none");
 *   3. each link is `{text, url, label}` in db order, internal columns dropped;
 *   4. `compact` and `fields` cannot hide it — and the whole answer costs one
 *      batch query, never one per thought.
 *
 * Every action that emits thought objects is covered: search/clusters/list/get/
 * context/chain on `memory_recall` and `timeline` on `memory_reflect`.
 */

mock.module('../../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: () => [new Float32Array(384)],
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

/** No project is registered for this path, so the answer keeps the global scope. */
const UNSCOPED_CWD = '/tmp/url-links-contract'
const QUERY = 'url_links_contract_marker'

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

interface Envelope {
  items?: Array<Record<string, any>>
  item?: Record<string, any>
  meta?: Record<string, any>
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Envelope> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>
    isError?: boolean
  }
  const text = result.content?.[0]?.text ?? '{}'
  expect(result.isError === true).toBe(false)
  return JSON.parse(text) as Envelope
}

function recall(args: Record<string, unknown>): Promise<Envelope> {
  return callTool('memory_recall', args)
}

function timeline(args: Record<string, unknown> = {}): Promise<Envelope> {
  return callTool('memory_reflect', { action: 'timeline', cwd: UNSCOPED_CWD, ...args })
}

/** One url link on a thought, with an explicit db order. */
function addLink(thoughtId: string, key: string, url: string, label: string, sortOrder: number): void {
  upsertThoughtUrlLink(getDb(), thoughtId, key, url, label, sortOrder)
}

/** A thought carrying one link, plus the id. */
function seedLinked(content: string): string {
  const id = seedThought({ content })
  addLink(id, 'docs', 'https://example.com/docs', 'Docs', 0)
  return id
}

/** Whether any thought object anywhere in the answer carries the opt-in key. */
function carriesUrlLinks(envelope: Envelope): boolean {
  return JSON.stringify(envelope).includes('"url_links"')
}

beforeEach(createTestDb)
afterEach(closeDb)

beforeEach(async () => {
  client = await setupClient()
})

// ── absence is the default ──────────────────────────────────────────────────

describe('include_url_links is absent unless asked', () => {
  test('every recall action and reflect timeline omit the key by default', async () => {
    const head = seedLinked(`${QUERY} head`)
    const neighbour = seedLinked(`${QUERY} neighbour`)
    createEdge(getDb(), head, neighbour, 'related')

    const answers: Array<[string, Envelope]> = [
      ['search', await recall({ action: 'search', query: QUERY, cwd: UNSCOPED_CWD, compact: false })],
      ['list', await recall({ action: 'list', cwd: UNSCOPED_CWD, compact: false })],
      ['get', await recall({ action: 'get', thought_id: head, include_edges: true, compact: false })],
      ['chain', await recall({ action: 'chain', thought_id: head, compact: false })],
      ['context', await recall({ action: 'context', thought_id: head, compact: false })],
      ['timeline', await timeline({ compact: false })]
    ]

    for (const [action, answer] of answers) {
      expect({ action, hasKey: carriesUrlLinks(answer) }).toEqual({ action, hasKey: false })
    }
  })

  test('an explicit include_url_links: false is the same absence', async () => {
    const id = seedLinked(`${QUERY} explicit false`)
    const answer = await recall({ action: 'get', thought_id: id, include_url_links: false })
    expect(carriesUrlLinks(answer)).toBe(false)
  })
})

// ── asked, and there are none ───────────────────────────────────────────────

describe('include_url_links: true with no links answers []', () => {
  test('search and get attach an empty array, not a missing key', async () => {
    const id = seedThought({ content: `${QUERY} unlinked` })

    const search = await recall({ action: 'search', query: QUERY, cwd: UNSCOPED_CWD, include_url_links: true })
    expect(search.items?.[0]?.thought?.url_links).toEqual([])

    const get = await recall({ action: 'get', thought_id: id, include_url_links: true })
    expect(get.item?.url_links).toEqual([])
  })

  test('timeline rows carry an empty array too', async () => {
    seedThought({ content: `${QUERY} unlinked page row` })
    const page = await timeline({ include_url_links: true })
    expect(page.items?.[0]?.url_links).toEqual([])
  })
})

// ── shape and order ─────────────────────────────────────────────────────────

describe('the link shape is {text, url, label} in db order', () => {
  test('sort_order decides the order and no internal column is emitted', async () => {
    const id = seedThought({ content: `${QUERY} ordered links` })
    // Inserted out of order on purpose: the db order is sort_order, not insertion.
    addLink(id, 'third', 'https://example.com/3', 'Third', 30)
    addLink(id, 'first', 'https://example.com/1', 'First', 10)
    addLink(id, 'second', 'https://example.com/2', 'Second', 20)

    const answer = await recall({ action: 'list', cwd: UNSCOPED_CWD, include_url_links: true })
    const links = (answer.items ?? []).flatMap(item => item.url_links as Array<Record<string, unknown>>)

    expect(links.map(l => l.text)).toEqual(['first', 'second', 'third'])
    expect(links.map(l => l.url)).toEqual([
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3'
    ])
    expect(links.map(l => l.label)).toEqual(['First', 'Second', 'Third'])
    // Internal columns (id, thought_id, created_at) never reach the wire.
    for (const link of links) {
      expect(Object.keys(link).sort()).toEqual(['label', 'text', 'url'])
    }
  })

  test('the thought keeps its own links only', async () => {
    const one = seedLinked(`${QUERY} first thought`)
    const two = seedThought({ content: `${QUERY} second thought no links` })

    const answer = await recall({ action: 'search', query: QUERY, cwd: UNSCOPED_CWD, include_url_links: true })
    const thoughts = (answer.items ?? []).map(item => item.thought as { id: string; url_links: unknown })
    expect(thoughts.find(t => t.id === one)?.url_links).toEqual([
      { text: 'docs', url: 'https://example.com/docs', label: 'Docs' }
    ])
    expect(thoughts.find(t => t.id === two)?.url_links).toEqual([])
  })
})

// ── compact / fields cannot hide it ─────────────────────────────────────────

describe('compact and fields never trim url_links', () => {
  test('compact: true keeps url_links beside the minimal field set', async () => {
    const id = seedLinked(`${QUERY} compact thought`)
    const answer = await recall({ action: 'get', thought_id: id, compact: true, include_url_links: true })
    const item = answer.item as Record<string, unknown>

    expect(Object.keys(item).sort()).toEqual(['content', 'id', 'project', 'status', 'tags', 'url_links'])
    expect(item.url_links).toEqual([{ text: 'docs', url: 'https://example.com/docs', label: 'Docs' }])
  })

  test('fields: ["id"] answers {id, url_links}', async () => {
    const id = seedLinked(`${QUERY} selected fields`)
    const answer = await recall({ action: 'get', thought_id: id, fields: ['id'], include_url_links: true })
    const item = answer.item as Record<string, unknown>

    expect(Object.keys(item).sort()).toEqual(['id', 'url_links'])
    expect(item.id).toBe(id)
  })

  test('fields do not trim the links of a list page either', async () => {
    const id = seedLinked(`${QUERY} media list row`)
    const answer = await recall({ action: 'list', cwd: UNSCOPED_CWD, fields: ['id'], include_url_links: true })
    const rows = (answer.items ?? []).filter(item => item.id === id)
    expect(rows).toHaveLength(1)
    expect((rows[0].url_links as unknown[]).length).toBe(1)
  })
})

// ── every emitted thought object, not just the head ────────────────────────

describe('every thought the answer emits carries its links', () => {
  test('get attaches links to upstream and downstream neighbours', async () => {
    const head = seedLinked(`${QUERY} head with edges`)
    const upstream = seedLinked(`${QUERY} upstream neighbour`)
    const downstream = seedLinked(`${QUERY} downstream neighbour`)
    createEdge(getDb(), upstream, head, 'related')
    createEdge(getDb(), head, downstream, 'related')

    const answer = await recall({ action: 'get', thought_id: head, include_edges: true, include_url_links: true })
    const item = answer.item as Record<string, any>

    expect(item.url_links).toHaveLength(1)
    expect(item.upstream[0].thought.url_links).toEqual([
      { text: 'docs', url: 'https://example.com/docs', label: 'Docs' }
    ])
    expect(item.downstream[0].thought.url_links).toEqual([
      { text: 'docs', url: 'https://example.com/docs', label: 'Docs' }
    ])
  })

  test('chain attaches links to the head and both neighbourhoods', async () => {
    const head = seedLinked(`${QUERY} chain head`)
    const upstream = seedLinked(`${QUERY} chain upstream`)
    const downstream = seedLinked(`${QUERY} chain downstream`)
    createEdge(getDb(), upstream, head, 'related')
    createEdge(getDb(), head, downstream, 'related')

    const answer = await recall({ action: 'chain', thought_id: head, include_url_links: true })
    const item = answer.item as Record<string, any>

    expect(item.thought.url_links).toHaveLength(1)
    expect(item.upstream[0].thought.url_links).toHaveLength(1)
    expect(item.downstream[0].thought.url_links).toHaveLength(1)
  })

  test('context (id path) attaches links to the best match chain', async () => {
    const head = seedLinked(`${QUERY} context head`)
    const neighbour = seedLinked(`${QUERY} context neighbour`)
    createEdge(getDb(), neighbour, head, 'related')

    const answer = await recall({ action: 'context', thought_id: head, include_url_links: true })
    const item = answer.item as Record<string, any>

    expect(item.thought.url_links).toHaveLength(1)
    expect(item.chain.upstream[0].thought.url_links).toHaveLength(1)
  })

  test('a grouped search answer attaches links to cluster members', async () => {
    const member = seedLinked(`${QUERY} grouped member`)
    const cluster = seedThought({ content: `${QUERY} grouped cluster`, is_cluster: 1 })
    createEdge(getDb(), cluster, member, 'cluster')

    const answer = await recall({
      action: 'search',
      query: QUERY,
      cwd: UNSCOPED_CWD,
      group_by_cluster: true,
      include_url_links: true
    })
    const group = (answer.items ?? []).find(item => item.cluster !== undefined) as
      | { cluster: { id: string }; items: Array<{ thought: { id: string; url_links: unknown[] } }> }
      | undefined

    expect(group?.cluster.id).toBe(cluster)
    const memberHit = group?.items.find(i => i.thought.id === member)
    expect(memberHit?.thought.url_links).toHaveLength(1)
  })
})

// ── one batch query per response ───────────────────────────────────────────

describe('one batch query per response', () => {
  /**
   * Count the db reads the batch helper makes while `fn` runs. The spy
   * delegates to the real implementation and restores itself, so only the call
   * count is observed — the answer is still produced by real code.
   */
  async function countingBatchReads(fn: () => Promise<unknown>): Promise<{ calls: number; idArgs: string[][] }> {
    const real = thoughtUrlLinksDb.getThoughtUrlLinksForThoughts
    const idArgs: string[][] = []
    const spy = spyOn(thoughtUrlLinksDb, 'getThoughtUrlLinksForThoughts')
    spy.mockImplementation(((db: never, ids: string[]) => {
      idArgs.push([...ids])
      return real(db, ids)
    }) as never)
    try {
      await fn()
      return { calls: spy.mock.calls.length, idArgs }
    } finally {
      spy.mockRestore()
    }
  }

  test('a search over three linked thoughts reads once with every id', async () => {
    const ids = ['a', 'b', 'c'].map(suffix => seedLinked(`${QUERY} batch ${suffix}`))

    const { calls, idArgs } = await countingBatchReads(() =>
      recall({ action: 'search', query: QUERY, cwd: UNSCOPED_CWD, include_url_links: true })
    )

    expect(calls).toBe(1)
    expect([...idArgs[0]].sort()).toEqual([...ids].sort())
  })

  test('a list page reads once, whatever the page size', async () => {
    seedLinked(`${QUERY} page one`)
    seedLinked(`${QUERY} page two`)

    const { calls } = await countingBatchReads(() =>
      recall({ action: 'list', cwd: UNSCOPED_CWD, include_url_links: true })
    )

    expect(calls).toBe(1)
  })

  test('get with neighbours reads once for the head and both neighbourhoods', async () => {
    const head = seedLinked(`${QUERY} batch head`)
    const upstream = seedLinked(`${QUERY} batch upstream`)
    const downstream = seedLinked(`${QUERY} batch downstream`)
    createEdge(getDb(), upstream, head, 'related')
    createEdge(getDb(), head, downstream, 'related')

    const { calls, idArgs } = await countingBatchReads(() =>
      recall({ action: 'get', thought_id: head, include_edges: true, include_url_links: true })
    )

    expect(calls).toBe(1)
    expect([...idArgs[0]].sort()).toEqual([head, upstream, downstream].sort())
  })

  test('without the flag no url-link query runs at all', async () => {
    seedLinked(`${QUERY} no opt-in`)

    const { calls } = await countingBatchReads(() =>
      recall({ action: 'search', query: QUERY, cwd: UNSCOPED_CWD })
    )

    expect(calls).toBe(0)
  })
})

// ── the argument itself ────────────────────────────────────────────────────

describe('the argument surface', () => {
  test('both tools advertise include_url_links as a boolean', async () => {
    const { tools } = await client.listTools()
    for (const name of ['memory_recall', 'memory_reflect']) {
      const tool = tools.find(t => t.name === name)
      const properties = (tool?.inputSchema as { properties?: Record<string, { type?: string }> } | undefined)
        ?.properties
      expect(properties?.include_url_links?.type).toBe('boolean')
    }
  })
})
