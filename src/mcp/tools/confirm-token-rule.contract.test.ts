import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { getDb } from '../../db'
import { closeDb } from '../../db/init'
import { createTestDb, seedEdge, seedThought } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

interface ToolResult {
  content: Array<{ type: string; text: string }>
  structuredContent?: { result?: unknown }
  isError?: boolean
}

interface Body {
  item?: Record<string, unknown>
  items?: Array<Record<string, unknown>>
  meta: {
    preview?: { token?: string | null; destructive?: boolean }
    counts?: Record<string, number>
  }
  error?: { message?: string; statusCode?: number }
  text?: string
}

let client: Client

async function setupClient(): Promise<Client> {
  const server = new McpServer({ name: 'confirm-token-rule-contract-test', version: '1.0.0' })
  registerAllMemoryTools(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const result = new Client({ name: 'test-client', version: '1.0.0' })
  await result.connect(clientTransport)
  return result
}

async function call(tool: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name: tool, arguments: args })) as ToolResult
  return {
    body: result.structuredContent?.result as Body | undefined,
    isError: result.isError === true,
    text: result.content?.[0]?.text ?? ''
  }
}

const OLD_ISO = '2020-01-01T00:00:00.000Z'

function seedRetentionCandidate(content: string): string {
  const id = seedThought({ content, status: 'archived', is_protected: 0, created_at: OLD_ISO })
  const db = getDb()
  db.prepare('UPDATE thoughts SET archived_at = ? WHERE id = ?').run(OLD_ISO, id)
  db.prepare('UPDATE thought_importance SET importance = 0.1 WHERE thought_id = ?').run(id)
  return id
}

function destructiveSection(guide: string): string {
  const start = guide.indexOf('## Destructive operations')
  if (start === -1) throw new Error('the guide carries no destructive-operations section')
  const body = guide.slice(start)
  const end = body.search(/\n(?=## |Slots )/)
  return end === -1 ? body : body.slice(0, end)
}

beforeEach(async () => {
  createTestDb()
  client = await setupClient()
})
afterEach(async () => {
  await client?.close()
  closeDb()
})

describe('pin 1: a not-found archive/merge preview issues no token and stays unexecutable', () => {
  test('archive of a missing thought previews not_found with token null; confirm alone answers 404', async () => {
    const preview = await call('memory_supersede', {
      action: 'archive',
      thought_id: 'missing-archive-target'
    })
    expect(preview.isError).toBe(false)
    expect(preview.body?.item).toMatchObject({ outcome: 'not_found', current_status: null })
    expect(preview.body?.meta.preview).toEqual({ token: null, destructive: true })

    const confirmed = await call('memory_supersede', {
      action: 'archive',
      thought_id: 'missing-archive-target',
      confirm: true
    })
    expect(confirmed.isError).toBe(true)
    expect(confirmed.body?.error?.statusCode).toBe(404)
    expect(confirmed.body?.error?.message).toContain('missing-archive-target')
    expect(confirmed.text).toBe(confirmed.body?.error?.message ?? '')
    expect(
      getDb().prepare('SELECT id FROM thoughts WHERE id = ?').get('missing-archive-target')
    ).toBeNull()
  })

  test('merge with a missing source previews not_found with token null; confirm alone leaves the target untouched', async () => {
    const target = seedThought({ content: 'merge target stays untouched', status: 'active' })
    const before = getDb().prepare('SELECT * FROM thoughts WHERE id = ?').get(target)

    const preview = await call('memory_supersede', {
      action: 'merge',
      source_id: 'missing-merge-source',
      target_id: target
    })
    expect(preview.isError).toBe(false)
    expect(preview.body?.item?.outcome).toBe('not_found')
    expect(preview.body?.meta.preview).toEqual({ token: null, destructive: true })

    const confirmed = await call('memory_supersede', {
      action: 'merge',
      source_id: 'missing-merge-source',
      target_id: target,
      confirm: true
    })
    expect(confirmed.isError).toBe(true)
    expect(confirmed.body?.error?.statusCode).toBe(404)
    expect(getDb().prepare('SELECT * FROM thoughts WHERE id = ?').get(target)).toEqual(before)
    expect(
      getDb()
        .prepare('SELECT id FROM edges WHERE source_id = ? OR target_id = ?')
        .all(target, target)
    ).toEqual([])
  })
})

describe('pin 2: the genuinely tokenless previews still execute on confirm alone', () => {
  test('memory_store unlink_batch previews with token null and confirm alone deletes the edges', async () => {
    const source = seedThought({ content: 'unlink_batch source' })
    const target = seedThought({ content: 'unlink_batch target' })
    const edge = seedEdge(source, target, 'related')

    const preview = await call('memory_store', { action: 'unlink_batch', edge_ids: [edge] })
    expect(preview.isError).toBe(false)
    expect(preview.body?.meta.preview).toMatchObject({ token: null, destructive: true })
    expect(preview.body?.items).toMatchObject([{ edge_id: edge, status: 'preview' }])
    expect(getDb().prepare('SELECT id FROM edges WHERE id = ?').get(edge)).toBeTruthy()

    const confirmed = await call('memory_store', {
      action: 'unlink_batch',
      edge_ids: [edge],
      confirm: true
    })
    expect(confirmed.isError).toBe(false)
    expect(confirmed.body?.items).toMatchObject([{ edge_id: edge, status: 'deleted' }])
    expect(confirmed.body?.meta.counts?.deleted).toBe(1)
    expect(getDb().prepare('SELECT id FROM edges WHERE id = ?').get(edge)).toBeNull()
  })

  test('retention_review compact previews with token null and confirm alone writes the summary', async () => {
    const source = seedRetentionCandidate('compact source without a token')
    const args = {
      action: 'compact',
      source_ids: [source],
      summary: { content: 'compact summary without a token' }
    }

    const preview = await call('retention_review', args)
    expect(preview.isError).toBe(false)
    expect(preview.body?.item?.status).toBe('preview')
    expect(preview.body?.meta.preview).toMatchObject({ token: null, destructive: true })
    expect(
      getDb()
        .prepare("SELECT id FROM thoughts WHERE content = 'compact summary without a token'")
        .get()
    ).toBeNull()

    const confirmed = await call('retention_review', { ...args, confirm: true })
    expect(confirmed.isError).toBe(false)
    expect(confirmed.body?.item?.status).toBe('compacted')
    expect(confirmed.body?.item?.summary).toBeTruthy()
    expect(getDb().prepare('SELECT status FROM thoughts WHERE id = ?').get(source)).toEqual({
      status: 'archived'
    })
    expect(
      getDb()
        .prepare("SELECT status FROM thoughts WHERE content = 'compact summary without a token'")
        .get()
    ).toEqual({ status: 'active' })
  })
})

describe('pin 3: the guide states the token rule without universalising tokenless execution', () => {
  test('the destructive-operations section keeps the token rule and the missing-target caveat', async () => {
    const guide = await call('memory_guide', {})
    expect(guide.isError).toBe(false)
    const text = guide.body?.text ?? guide.text
    const section = destructiveSection(text)

    expect(section).toMatch(/token null/)
    expect(section).toMatch(/unlink_batch/)
    expect(section).toMatch(/retention_review compact/)
    expect(section).toMatch(/archive[/ ]merge/)
    expect(section).toMatch(/(does not exist|missing|not_found)/)
    expect(section).toMatch(/(still fails|fails with an error)/)
    expect(section).not.toMatch(/confirm:true alone (executes|succeeds)/)
  })
})
