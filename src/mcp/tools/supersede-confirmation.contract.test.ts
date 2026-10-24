import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getDb } from '../../db/container'
import { closeDb } from '../../db/init'
import { createTestDb, seedEdge, seedThought } from '../../test/helpers'
import { registerMemorySupersede } from './supersede'

let client: Client

async function connectClient(): Promise<Client> {
  const server = new McpServer({ name: 'supersede-contract-test', version: '1.0.0' })
  registerMemorySupersede(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const result = new Client({ name: 'test-client', version: '1.0.0' })
  await result.connect(clientTransport)
  return result
}

async function call(args: Record<string, unknown>) {
  const result = await client.callTool({ name: 'memory_supersede', arguments: args })
  const response = result as { content: Array<{ text: string }>; isError?: boolean }
  const text = response.content[0]?.text ?? '{}'
  try { return { data: JSON.parse(text), isError: response.isError === true } }
  catch { return { data: text, isError: response.isError === true } }
}

beforeEach(async () => {
  createTestDb()
  client = await connectClient()
})
afterEach(async () => {
  await client?.close()
  closeDb()
})

describe('memory_supersede confirmation contract', () => {
  test('archive omission and false preview do not write; true executes', async () => {
    const id = seedThought({ content: 'private archive content', status: 'active', tags: 'secret-tag' })
    for (const confirm of [undefined, false]) {
      const result = await call({ action: 'archive', thought_id: id, ...(confirm === undefined ? {} : { confirm }) })
      expect(result.isError).toBe(false)
      expect(result.data).toMatchObject({ status: 'preview', action: 'archive', thought_id: id, current_status: 'active', outcome: 'would_archive' })
      expect(JSON.stringify(result.data)).not.toContain('private archive content')
      expect(JSON.stringify(result.data)).not.toContain('secret-tag')
      expect(getDb().query('select status from thoughts where id = ?').get(id)).toEqual({ status: 'active' })
    }
    const archPreview = await call({ action: 'archive', thought_id: id })
    const executed = await call({ action: 'archive', thought_id: id, confirm: true, preview_token: archPreview.data.preview_token })
    expect(executed.isError).toBe(false)
    expect(executed.data).toMatchObject({ status: 'executed', action: 'archive', result: { id, status: 'archived' } })
  })

  test('archive preview differentiates missing, archived and protected thoughts', async () => {
    const archived = seedThought({ content: 'archived', status: 'archived' })
    const protectedId = seedThought({ content: 'profile', status: 'active', is_profile: 1 })
    expect((await call({ action: 'archive', thought_id: 'missing-id' })).data.outcome).toBe('not_found')
    expect((await call({ action: 'archive', thought_id: archived })).data.outcome).toBe('already_archived')
    expect((await call({ action: 'archive', thought_id: protectedId })).data.outcome).toBe('protected')
  })

  test('archive_batch preview preserves order and labels duplicates and partial cases', async () => {
    const active = seedThought({ content: 'active', status: 'active' })
    const archived = seedThought({ content: 'old', status: 'archived' })
    const protectedId = seedThought({ content: 'protected', status: 'active', is_profile: 1 })
    const ids = [active, 'missing-id', archived, active, protectedId]
    const preview = await call({ action: 'archive_batch', thought_ids: ids })
    expect(preview.isError).toBe(false)
    expect(preview.data).toMatchObject({ status: 'preview', action: 'archive_batch', requested_count: ids.length })
    expect(preview.data.items).toEqual([
      { thought_id: active, outcome: 'would_archive' }, { thought_id: 'missing-id', outcome: 'not_found' },
      { thought_id: archived, outcome: 'already_archived' }, { thought_id: active, outcome: 'already_archived' },
      { thought_id: protectedId, outcome: 'protected' }
    ])
    expect(getDb().query('select status from thoughts where id = ?').get(active)).toEqual({ status: 'active' })
  })

  test('confirmed archive_batch returns ordered errors and preserves partial commits', async () => {
    const active = seedThought({ content: 'batch active', status: 'active' })
    const protectedId = seedThought({ content: 'batch profile', status: 'active', is_profile: 1 })
    const ids = [active, 'missing-id', protectedId, active]
    const batchPreview = await call({ action: 'archive_batch', thought_ids: ids })
    const result = await call({ action: 'archive_batch', thought_ids: ids, confirm: true, preview_token: batchPreview.data.preview_token })
    expect(result.isError).toBe(false)
    expect(result.data).toMatchObject({ status: 'executed', action: 'archive_batch' })
    expect(result.data.result).toMatchObject({
      archived: 2,
      failed: 2,
      errors: [
        { thought_id: 'missing-id', error: "Thought 'missing-id' not found" },
        { thought_id: protectedId, error: 'Profile thoughts cannot be archived — clear the is_profile flag first' }
      ]
    })
    expect(result.data.result.errors.map((item: { thought_id: string }) => item.thought_id)).toEqual([ids[1], ids[2]])
    expect(getDb().query('select status from thoughts where id = ?').get(active)).toEqual({ status: 'archived' })
    expect(getDb().query('select status from thoughts where id = ?').get(protectedId)).toEqual({ status: 'active' })
  })

  test('merge preview reports proposed fields and bounded edge descriptors without writes', async () => {
    const source = seedThought({ content: 'source secret content', status: 'active', tags: 'source-secret' })
    const target = seedThought({ content: 'target original', status: 'active' })
    const edgeIds: string[] = []
    for (let i = 0; i < 160; i++) {
      const node = seedThought({ content: `edge target ${i}`, status: 'active' })
      edgeIds.push(seedEdge(source, node, 'develops'))
    }
    const beforeEdges = (getDb().query('select count(*) as n from edges').get() as { n: number }).n
    const preview = await call({ action: 'merge', source_id: source, target_id: target, merged_content: 'proposed replacement', merged_tags: ['proposed'], project_id: 'project-x' })
    expect(preview.isError).toBe(false)
    expect(preview.data).toMatchObject({ status: 'preview', action: 'merge', outcome: 'would_merge',
      proposed: { merged_content: 'proposed replacement', merged_tags: ['proposed'], project_id: 'project-x' },
      effects: { source_archived: true, target_updated: true, replaces_edge_created: true },
      source: { id: source, status: 'active', source_edge_count: 160, truncated: true }, target: { id: target, status: 'active' } })
    expect(preview.data.source.edges).toHaveLength(50)
    expect(preview.data.source.edges.map((edge: { id: string }) => edge.id)).toEqual(edgeIds.sort().slice(0, 50))
    expect(getDb().query('select status from thoughts where id = ?').get(source)).toEqual({ status: 'active' })
    expect(getDb().query('select content from thoughts where id = ?').get(target)).toEqual({ content: 'target original' })
    expect((getDb().query('select count(*) as n from edges').get() as { n: number }).n).toBe(beforeEdges)
  })

  test('merge omission/false preview do not mutate; confirmation executes proposed fields', async () => {
    const source = seedThought({ content: 'source', status: 'active' })
    const target = seedThought({ content: 'target', status: 'active' })
    for (const confirm of [undefined, false]) {
      const result = await call({ action: 'merge', source_id: source, target_id: target, merged_content: 'merged', ...(confirm === undefined ? {} : { confirm }) })
      expect(result.isError).toBe(false)
      expect(result.data.status).toBe('preview')
      expect(getDb().query('select status from thoughts where id = ?').get(source)).toEqual({ status: 'active' })
      expect(getDb().query('select content from thoughts where id = ?').get(target)).toEqual({ content: 'target' })
    }
    const mergePreview = await call({ action: 'merge', source_id: source, target_id: target, merged_content: 'merged' })
    const result = await call({ action: 'merge', source_id: source, target_id: target, merged_content: 'merged', confirm: true, preview_token: mergePreview.data.preview_token })
    expect(result.isError).toBe(false)
    expect(result.data).toMatchObject({ status: 'executed', action: 'merge', result: { target: { content: 'merged' } } })
    expect(getDb().query('select status from thoughts where id = ?').get(source)).toEqual({ status: 'archived' })
  })

  test('merge revalidates stale preview and does not partially update target', async () => {
    const source = seedThought({ content: 'source', status: 'active' })
    const target = seedThought({ content: 'stable target', status: 'active' })
    expect((await call({ action: 'merge', source_id: source, target_id: target, merged_content: 'changed' })).data.status).toBe('preview')
    getDb().query("update thoughts set status = 'archived' where id = ?").run(source)
    const result = await call({ action: 'merge', source_id: source, target_id: target, merged_content: 'changed', confirm: true })
    expect(result.isError).toBe(true)
    expect(getDb().query('select content from thoughts where id = ?').get(target)).toEqual({ content: 'stable target' })
  })

  test('merge preview handles missing and ineligible pairs', async () => {
    expect((await call({ action: 'merge', source_id: 'missing', target_id: 'also-missing' })).data.outcome).toBe('not_found')
    const id = seedThought({ content: 'same', status: 'active' })
    expect((await call({ action: 'merge', source_id: id, target_id: id })).data).toMatchObject({ outcome: 'ineligible', reason: 'source_id and target_id must be different' })
    const archived = seedThought({ content: 'archived source', status: 'archived' })
    const target = seedThought({ content: 'target', status: 'active' })
    expect((await call({ action: 'merge', source_id: archived, target_id: target })).data.outcome).toBe('ineligible')
  })

  test('wrong confirmation types and irrelevant mutation controls fail without writes', async () => {
    const id = seedThought({ content: 'untouched', status: 'active' })
    for (const args of [
      { action: 'archive', thought_id: id, confirm: 'true' },
      { action: 'archive', thought_id: id, source_id: id },
      { action: 'archive_batch', thought_ids: [id], merged_content: 'x' },
      { action: 'merge', source_id: id, target_id: id, thought_ids: [id] }
    ]) {
      const result = await call(args)
      expect(result.isError).toBe(true)
      expect(String(result.data)).toMatch(/confirm must be a boolean|not applicable|expected boolean/)
      expect(getDb().query('select status from thoughts where id = ?').get(id)).toEqual({ status: 'active' })
    }
  })
})
