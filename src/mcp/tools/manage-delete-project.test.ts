import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { getDb } from '../../context/container'
import { closeDb } from '../../db/init'
import { createProject, resolveDefaultProjectId } from '../../db/projects'
import { createTestDb, seedThought } from '../../test/helpers'
import { registerMemoryManage } from './manage'

const OLDER = '2026-01-01T00:00:00.000Z'
const NEWER = '2026-01-02T00:00:00.000Z'

async function setupClient(): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerMemoryManage(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await client.connect(clientTransport)
  return client
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

async function previewDeletion(client: Client, projectId: string) {
  return parseResult(
    await client.callTool({
      name: 'memory_manage',
      arguments: { action: 'delete', project_id: projectId }
    })
  ).data
}

async function confirmDeletion(client: Client, projectId: string, token: string) {
  return parseResult(
    await client.callTool({
      name: 'memory_manage',
      arguments: { action: 'delete', project_id: projectId, confirm: true, preview_token: token }
    })
  ).data
}

beforeEach(createTestDb)
afterEach(closeDb)

describe('memory_manage delete of a project holding collisions', () => {
  test('the preview names the archiving that the confirmed answer reports', async () => {
    const client = await setupClient()
    const db = getDb()
    const defaultId = resolveDefaultProjectId(db)
    const project = createProject(db, { name: 'Doomed' })
    seedThought({ content: 'shared body', project_id: defaultId, created_at: OLDER })
    const archivedId = seedThought({
      content: 'shared body',
      project_id: project.id,
      created_at: NEWER
    })
    seedThought({ content: 'unique body', project_id: project.id, created_at: NEWER })

    const preview = await previewDeletion(client, project.id)

    expect(preview.item.action).toBe('preview')
    expect(preview.item.consequence).toContain('archived')
    expect(preview.item.thought_count).toBe(2)

    const executed = await confirmDeletion(client, project.id, preview.item.preview_token)

    expect(executed.action).toBe('deleted')
    expect(executed.thoughts_moved).toBe(preview.item.thought_count)
    expect(executed.thoughts_archived).toBe(1)
    expect(executed.archived_thought_ids).toEqual([archivedId])
  })
})

describe('memory_manage delete of a project without collisions', () => {
  test('the answer keeps every field a thoughts_moved client reads, plus zero archived', async () => {
    const client = await setupClient()
    const db = getDb()
    const project = createProject(db, { name: 'Doomed' })
    seedThought({ content: 'first body', project_id: project.id, created_at: NEWER })
    seedThought({ content: 'second body', project_id: project.id, created_at: NEWER })

    const preview = await previewDeletion(client, project.id)
    const item = await confirmDeletion(client, project.id, preview.item.preview_token)
    const { action, project: deletedProject, thoughts_moved, moved_to } = item

    expect({ action, project: deletedProject, thoughts_moved, moved_to }).toEqual({
      action: 'deleted',
      project: { id: project.id, name: 'Doomed' },
      thoughts_moved: 2,
      moved_to: 'Default project'
    })
    expect(item.thoughts_archived).toBe(0)
    expect(item.archived_thought_ids).toEqual([])
  })

  test('a project with no thoughts reports no move and no archived row', async () => {
    const client = await setupClient()
    const project = createProject(getDb(), { name: 'Empty' })

    const preview = await previewDeletion(client, project.id)
    const item = await confirmDeletion(client, project.id, preview.item.preview_token)

    expect(item.thoughts_moved).toBe(0)
    expect('moved_to' in item).toBe(false)
    expect(item.thoughts_archived).toBe(0)
    expect(item.archived_thought_ids).toEqual([])
  })
})
