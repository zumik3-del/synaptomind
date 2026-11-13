/**
 * An id-addressed write (`memory_store action=update`, `memory_supersede
 * action=merge`) keeps the project its row already has; the cwd only scopes the
 * answer. Before task #2530 both writes passed the cwd-resolved project into the
 * store, which moved the row and rehashed its content against that project.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { getDb } from '../../context/container'
import { closeDb } from '../../db/init'
import { resolveDefaultProjectId } from '../../db/projects'
import { createProjectService } from '../../services/projects.service'
import { createTestDb, seedThought } from '../../test/helpers'
import { computeContentHash } from '../../utils'
import { registerAllMemoryTools } from '.'

const FOREIGN_CWD = '/tmp/t2542-foreign-project'
const UNKNOWN_CWD = '/tmp/t2542-unregistered-project'
const HOME_PATH = '/tmp/t2542-home'

let client: Client

async function setupClient(): Promise<Client> {
  const server = new McpServer({ name: 'id-addressed-write-scope-test', version: '0.0.0' })
  registerAllMemoryTools(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const result = new Client({ name: 'test-client', version: '0.0.0' })
  await result.connect(clientTransport)
  return result
}

async function call(tool: string, args: Record<string, unknown>) {
  const response = (await client.callTool({ name: tool, arguments: args })) as {
    content: Array<{ text: string }>
    isError?: boolean
  }
  const text = response.content[0]?.text ?? '{}'
  try {
    return { data: JSON.parse(text) as any, isError: response.isError === true, text }
  } catch {
    return { data: text, isError: response.isError === true, text }
  }
}

interface Row {
  project_id: string
  content_hash: string | null
  content: string
  status: string
}

function rowOf(id: string): Row {
  return getDb()
    .prepare('SELECT project_id, content_hash, content, status FROM thoughts WHERE id = ?')
    .get(id) as Row
}

/** A project with a registered path, and a thought of another project to address. */
function seedProjects(): { foreignId: string; homeId: string } {
  const foreign = createProjectService({ name: 'Foreign project', local_path: FOREIGN_CWD })
  const home = createProjectService({ name: 'Home project', local_path: HOME_PATH })
  return { foreignId: foreign.id, homeId: home.id }
}

function seedForeignScopedThought(): { foreignId: string; homeId: string; thoughtId: string } {
  const { foreignId, homeId } = seedProjects()
  const thoughtId = seedThought({
    content: 'original content',
    status: 'active',
    project_id: homeId
  })
  getDb()
    .prepare('UPDATE thoughts SET content_hash = ? WHERE id = ?')
    .run(computeContentHash('original content', homeId), thoughtId)
  return { foreignId, homeId, thoughtId }
}

beforeEach(createTestDb)
afterEach(closeDb)
beforeAll(async () => {
  client = await setupClient()
})

describe('memory_store action=update — an id-addressed write keeps its row project', () => {
  test('a content edit through a registered foreign cwd keeps the project and hashes against it', async () => {
    const { foreignId, homeId, thoughtId } = seedForeignScopedThought()

    const updated = await call('memory_store', {
      action: 'update',
      thought_id: thoughtId,
      content: 'edited content',
      cwd: FOREIGN_CWD
    })

    expect(updated.isError).toBe(false)
    expect(updated.data.item.project_id).toBe(homeId)
    expect(rowOf(thoughtId)).toMatchObject({
      project_id: homeId,
      content_hash: computeContentHash('edited content', homeId),
      content: 'edited content'
    })
    expect(updated.data.meta.scope).toEqual({
      project: foreignId,
      project_name: 'Foreign project',
      global: false
    })
  })

  test('a tags-only edit through a registered foreign cwd leaves the content hash untouched', async () => {
    const { homeId, thoughtId } = seedForeignScopedThought()
    const before = rowOf(thoughtId)
    expect(before.content_hash).toBe(computeContentHash('original content', homeId))

    const updated = await call('memory_store', {
      action: 'update',
      thought_id: thoughtId,
      tags: ['scoped-write'],
      cwd: FOREIGN_CWD
    })

    expect(updated.isError).toBe(false)
    expect(rowOf(thoughtId)).toMatchObject({
      project_id: homeId,
      content_hash: before.content_hash
    })
  })

  test('an unregistered cwd reports the global scope and leaves the row project alone', async () => {
    const { homeId, thoughtId } = seedForeignScopedThought()

    const updated = await call('memory_store', {
      action: 'update',
      thought_id: thoughtId,
      content: 'edited content',
      cwd: UNKNOWN_CWD
    })

    expect(updated.isError).toBe(false)
    expect(updated.data.meta.scope).toEqual({ project: null, project_name: null, global: true })
    expect(rowOf(thoughtId)).toMatchObject({
      project_id: homeId,
      content_hash: computeContentHash('edited content', homeId)
    })
  })

  test('a create through the same registered foreign cwd still lands in that project', async () => {
    const { foreignId } = seedForeignScopedThought()

    const created = await call('memory_store', {
      action: 'create',
      content: 'created through the foreign path',
      status: 'active',
      cwd: FOREIGN_CWD
    })

    expect(created.isError).toBe(false)
    expect(created.data.item.project_id).toBe(foreignId)
    expect(rowOf(created.data.item.id)).toMatchObject({
      project_id: foreignId,
      content_hash: computeContentHash('created through the foreign path', foreignId)
    })
    expect(created.data.meta.scope).toEqual({
      project: foreignId,
      project_name: 'Foreign project',
      global: false
    })
  })

  test('a create without cwd still lands in the default project', async () => {
    const created = await call('memory_store', {
      action: 'create',
      content: 'created without a scope',
      status: 'active'
    })

    expect(created.isError).toBe(false)
    expect(created.data.item.project_id).toBe(resolveDefaultProjectId(getDb()))
    expect(created.data.meta.scope).toBeNull()
  })
})

describe('memory_supersede action=merge — an id-addressed write keeps the target project', () => {
  function seedMergePair(): {
    foreignId: string
    homeId: string
    sourceId: string
    targetId: string
  } {
    const { foreignId, homeId } = seedProjects()
    return {
      foreignId,
      homeId,
      sourceId: seedThought({ content: 'source content', status: 'active', project_id: homeId }),
      targetId: seedThought({ content: 'target content', status: 'active', project_id: homeId })
    }
  }

  async function confirmMerge(
    sourceId: string,
    targetId: string,
    mergedContent: string,
    cwd?: string
  ) {
    const scoped = cwd === undefined ? {} : { cwd }
    const preview = await call('memory_supersede', {
      action: 'merge',
      source_id: sourceId,
      target_id: targetId,
      merged_content: mergedContent,
      ...scoped
    })
    expect(preview.isError).toBe(false)
    const executed = await call('memory_supersede', {
      action: 'merge',
      source_id: sourceId,
      target_id: targetId,
      merged_content: mergedContent,
      confirm: true,
      preview_token: preview.data.item.preview_token,
      ...scoped
    })
    return { preview, executed }
  }

  test('a merge through a registered foreign cwd archives the source and keeps the target project', async () => {
    const { foreignId, homeId, sourceId, targetId } = seedMergePair()

    const { preview, executed } = await confirmMerge(
      sourceId,
      targetId,
      'merged content',
      FOREIGN_CWD
    )

    expect(preview.data.item.proposed).not.toHaveProperty('project_id')
    expect(preview.data.meta.scope).toEqual({
      project: foreignId,
      project_name: 'Foreign project',
      global: false
    })
    expect(executed.isError).toBe(false)
    expect(executed.data.item).toMatchObject({
      status: 'executed',
      action: 'merge',
      result: { target: { content: 'merged content', project_id: homeId } }
    })
    expect(rowOf(sourceId).status).toBe('archived')
    expect(rowOf(targetId)).toMatchObject({
      project_id: homeId,
      content_hash: computeContentHash('merged content', homeId)
    })
  })

  test('a merge without cwd reports scope null and still keeps the target project', async () => {
    const { homeId, sourceId, targetId } = seedMergePair()

    const { preview, executed } = await confirmMerge(sourceId, targetId, 'merged content')

    expect(preview.data.meta.scope).toBeNull()
    expect(executed.data.meta.scope).toBeNull()
    expect(rowOf(targetId)).toMatchObject({ project_id: homeId })
    expect(rowOf(sourceId).status).toBe('archived')
  })

  test('an unregistered cwd reports the global scope and still keeps the target project', async () => {
    const { homeId, sourceId, targetId } = seedMergePair()

    const { executed } = await confirmMerge(sourceId, targetId, 'merged content', UNKNOWN_CWD)

    expect(executed.data.meta.scope).toEqual({ project: null, project_name: null, global: true })
    expect(rowOf(targetId).project_id).toBe(homeId)
  })
})
