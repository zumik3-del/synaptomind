import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { getDb } from '../../context/container'
import { closeDb } from '../../db/init'
import { createProjectService } from '../../services/projects.service'
import { createTestDb, seedThought } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

mock.module('../../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: () => [new Float32Array(384)],
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

const GLOBAL_QUERY = 'BULKITEM_GLOBAL_MARKER'
const P1_CWD = '/tmp/bulk-item-p1'
const P2_CWD = '/tmp/bulk-item-p2'

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

interface Answer {
  envelope: Envelope
  isError: boolean
  text: string
}

async function call(name: string, args: Record<string, unknown>): Promise<Answer> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>
    isError?: boolean
  }
  const text = result.content?.[0]?.text ?? '{}'
  const envelope = result.isError === true ? {} : (JSON.parse(text) as Envelope)
  return { envelope, isError: result.isError === true, text }
}

function bulk(
  thoughts: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {}
): Promise<Answer> {
  return call('memory_store', { action: 'bulk_create', thoughts, ...extra })
}

function recall(args: Record<string, unknown>): Promise<Answer> {
  return call('memory_recall', args)
}

function createdIds(answer: Answer): string[] {
  return (answer.envelope.items ?? []).map(row => String(row.thought?.id))
}

function rowStates(answer: Answer): Array<[number, string]> {
  return (answer.envelope.items ?? []).map(row => [row.index as number, row.status as string])
}

function linksOf(thoughtId: string): Array<Record<string, unknown>> {
  return getDb()
    .prepare(
      'SELECT key, url, label, sort_order FROM thought_url_links WHERE thought_id = ? ORDER BY sort_order'
    )
    .all(thoughtId) as Array<Record<string, unknown>>
}

function thoughtRow(id: string): {
  project_id: string
  source: string | null
  is_global: number
  is_protected: number
} {
  return getDb()
    .prepare('SELECT project_id, source, is_global, is_protected FROM thoughts WHERE id = ?')
    .get(id) as {
    project_id: string
    source: string | null
    is_global: number
    is_protected: number
  }
}

function edgesInto(id: string): Array<{ source_id: string; type: string }> {
  return getDb().prepare('SELECT source_id, type FROM edges WHERE target_id = ?').all(id) as Array<{
    source_id: string
    type: string
  }>
}

function count(sql: string): number {
  return (getDb().prepare(sql).get() as { n: number }).n
}

beforeEach(createTestDb)
afterEach(closeDb)

beforeEach(async () => {
  client = await setupClient()
})

afterEach(async () => {
  await client?.close()
})

describe('bulk_create item url_links', () => {
  test('writes each item links in array order with sort_order = array index', async () => {
    const answer = await bulk([
      {
        content: 'bulk links item one',
        url_links: [
          { text: 'first', url: 'https://example.com/first' },
          { text: 'second', url: 'https://example.com/second' }
        ]
      },
      { content: 'bulk links item two' }
    ])

    expect(answer.isError).toBe(false)
    const [one, two] = createdIds(answer)
    expect(linksOf(one)).toEqual([
      { key: 'first', url: 'https://example.com/first', label: 'first', sort_order: 0 },
      { key: 'second', url: 'https://example.com/second', label: 'second', sort_order: 1 }
    ])
    expect(linksOf(two)).toEqual([])
  })

  test('the answer carries the created thought and recall shows its links', async () => {
    const answer = await bulk([
      {
        content: 'bulk links recall item',
        url_links: [
          { text: 'docs', url: 'https://example.com/docs' },
          { text: 'repo', url: 'https://example.com/repo' }
        ]
      }
    ])

    expect(answer.isError).toBe(false)
    const row = (answer.envelope.items ?? [])[0]
    expect(row.status).toBe('created')
    expect(row.thought.content).toBe('bulk links recall item')
    expect(row.thought.id).toBeString()

    const got = await recall({
      action: 'get',
      thought_id: row.thought.id,
      include_url_links: true
    })
    expect(got.envelope.item?.url_links).toEqual([
      { text: 'docs', url: 'https://example.com/docs', label: 'docs' },
      { text: 'repo', url: 'https://example.com/repo', label: 'repo' }
    ])
  })
})

describe('bulk_create item is_global', () => {
  function twoProjects(): { p1: string; p2: string } {
    const p1 = createProjectService({ name: 'Bulk Item P1', local_path: P1_CWD }).id
    const p2 = createProjectService({ name: 'Bulk Item P2', local_path: P2_CWD }).id
    return { p1, p2 }
  }

  async function scopedSearch(): Promise<string[]> {
    const answer = await recall({ action: 'search', query: GLOBAL_QUERY, cwd: P1_CWD, limit: 10 })
    expect(answer.isError).toBe(false)
    return (answer.envelope.items ?? []).map(row => String(row.thought.id))
  }

  test('is_global:true persists 1 and reaches a scoped search of another project', async () => {
    const { p2 } = twoProjects()
    const answer = await bulk([
      {
        content: `${GLOBAL_QUERY} global item`,
        status: 'active',
        is_global: true,
        project_id: p2
      }
    ])

    expect(answer.isError).toBe(false)
    const id = createdIds(answer)[0]
    expect((answer.envelope.items ?? [])[0].thought.is_global).toBe(true)
    expect((answer.envelope.items ?? [])[0].thought.status).toBe('active')
    expect(thoughtRow(id)).toMatchObject({ is_global: 1, project_id: p2 })
    expect(await scopedSearch()).toContain(id)
  })

  test('an omitted is_global stays 0 and does not leak into another project', async () => {
    const { p2 } = twoProjects()
    const answer = await bulk([
      { content: `${GLOBAL_QUERY} local item`, status: 'active', project_id: p2 }
    ])

    expect(answer.isError).toBe(false)
    const id = createdIds(answer)[0]
    expect(thoughtRow(id).is_global).toBe(0)
    expect(await scopedSearch()).not.toContain(id)
  })
})

describe('bulk_create item refusals', () => {
  test('an unknown key is refused with its item path and the key name, writing nothing', async () => {
    const answer = await bulk([
      { content: 'valid first item' },
      { content: 'typo second item', is_glboal: true }
    ])

    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('Unrecognized key')
    expect(answer.text).toContain('is_glboal')
    expect(answer.text).toContain('thoughts.1')
    expect(count('SELECT COUNT(*) AS n FROM thoughts')).toBe(0)
  })

  test('the retired is_profile is refused with its replacement-style message', async () => {
    const answer = await bulk([{ content: 'retired field item', is_profile: true }])

    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('is_profile is retired')
    expect(answer.text).toContain('thoughts.0')
    expect(count('SELECT COUNT(*) AS n FROM thoughts')).toBe(0)
  })

  test('an item without content is refused at its item path', async () => {
    const answer = await bulk([{ tags: ['no-content-item'] }])

    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('each thought requires a non-empty content')
    expect(answer.text).toContain('thoughts.0')
    expect(count('SELECT COUNT(*) AS n FROM thoughts')).toBe(0)
  })
})

describe('bulk_create honours the per-item project, source and relation', () => {
  test('project_id, source, relation, tags and is_protected land per item', async () => {
    const p3 = createProjectService({ name: 'Bulk Item P3', local_path: '/tmp/bulk-item-p3' }).id
    const p4 = createProjectService({ name: 'Bulk Item P4', local_path: '/tmp/bulk-item-p4' }).id
    const parent = seedThought({ content: 'bulk parent marker' })

    const answer = await bulk(
      [
        {
          content: 'item with a parent',
          project_id: p3,
          source: 'bulk-fixture',
          parent_id: parent,
          relation: 'develops',
          tags: ['bulk-item-tag'],
          is_protected: false
        },
        { content: 'item that inherits the cwd project' }
      ],
      { cwd: '/tmp/bulk-item-p4' }
    )

    expect(answer.isError).toBe(false)
    const [first, second] = createdIds(answer)
    expect(thoughtRow(first)).toMatchObject({
      project_id: p3,
      source: 'bulk-fixture',
      is_protected: 0
    })
    expect((answer.envelope.items ?? [])[0].thought.tags).toEqual(['bulk-item-tag'])
    expect(edgesInto(first)).toEqual([{ source_id: parent, type: 'develops' }])
    expect(thoughtRow(second).project_id).toBe(p4)
  })
})

describe('bulk_create ignores the top-level create fields', () => {
  test('a top-level is_global, url_links and tags never reach the items', async () => {
    const answer = await bulk([{ content: 'top level fields ignored item' }], {
      is_global: true,
      url_links: [{ text: 'top', url: 'https://example.com/top' }],
      tags: ['top-tag']
    })

    expect(answer.isError).toBe(false)
    const id = createdIds(answer)[0]
    expect(thoughtRow(id).is_global).toBe(0)
    expect(linksOf(id)).toEqual([])
    expect((answer.envelope.items ?? [])[0].thought.tags).toEqual([])
  })
})

describe('bulk_create batch semantics', () => {
  test('an empty thoughts array is refused and writes nothing', async () => {
    const answer = await bulk([])

    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('thoughts is required for bulk_create action')
    expect(count('SELECT COUNT(*) AS n FROM thoughts')).toBe(0)
  })

  test('10001 items are refused at the ceiling and write nothing', async () => {
    const thoughts = Array.from({ length: 10_001 }, (_, i) => ({ content: `bulk ceiling ${i}` }))
    const answer = await bulk(thoughts)

    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('at most 10000 items')
    expect(count('SELECT COUNT(*) AS n FROM thoughts')).toBe(0)
  })

  test('one failing item yields its error row without aborting the batch', async () => {
    const answer = await bulk([
      { content: 'kept before the failure' },
      { content: 'missing parent item', parent_id: 'no-such-thought' },
      { content: 'kept after the failure' }
    ])

    expect(answer.isError).toBe(false)
    expect(rowStates(answer)).toEqual([
      [0, 'created'],
      [1, 'failed'],
      [2, 'created']
    ])
    expect(answer.envelope.items?.[1].error).toContain('FOREIGN KEY')
    expect(answer.envelope.meta?.counts).toMatchObject({ created: 2, failed: 1 })
    expect(count('SELECT COUNT(*) AS n FROM thoughts')).toBe(2)
    expect(count('SELECT COUNT(*) AS n FROM pending_embeddings')).toBe(2)
    expect(count("SELECT COUNT(*) AS n FROM thoughts WHERE content = 'missing parent item'")).toBe(
      0
    )
  })
})

describe('the advertised bulk item schema', () => {
  async function advertisedThoughts(): Promise<Record<string, any>> {
    const { tools } = await client.listTools()
    const store = tools.find(t => t.name === 'memory_store')
    if (!store) throw new Error('memory_store is not advertised')
    const properties = (store.inputSchema as { properties?: Record<string, any> }).properties
    if (!properties) throw new Error('memory_store advertises no properties')
    return properties.thoughts as Record<string, any>
  }

  test('is a closed object declaring exactly the fields bulk writes', async () => {
    const thoughts = await advertisedThoughts()
    const item = thoughts.items as Record<string, any>

    expect(thoughts.type).toBe('array')
    expect(item.type).toBe('object')
    expect(item.additionalProperties).toBe(false)
    expect(item.required).toEqual(['content'])
    expect(Object.keys(item.properties).sort()).toEqual([
      'content',
      'is_global',
      'is_profile',
      'is_protected',
      'parent_id',
      'project_id',
      'relation',
      'source',
      'status',
      'tags',
      'url_links'
    ])
  })

  test('describes the url_links, is_global and unknown-key behaviour', async () => {
    const description = (await advertisedThoughts()).description as string

    expect(description).toContain('url_links')
    expect(description).toContain('is_global')
    expect(description).toContain('unknown key')
  })
})
