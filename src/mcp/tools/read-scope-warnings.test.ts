import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { closeDb } from '../../db/init'
import { createProjectService } from '../../services/projects.service'
import { createTestDb, seedThought } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

const CWD = '/tmp/t2188-read-scope'

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

function seedTwoProjects(): { scopedId: string; otherId: string; projectId: string } {
  const project = createProjectService({ name: 'ReadScopeProject', local_path: CWD })
  return {
    projectId: project.id,
    scopedId: seedThought({ content: 'SCOPED_READ marker', project_id: project.id }),
    otherId: seedThought({ content: 'OTHER_PROJECT_READ marker', project_id: 'default' })
  }
}

describe('memory_crystallize action=graph — scope is reported', () => {
  test('a cwd-less call answers every project with scope null and a warning', async () => {
    const { scopedId, otherId } = seedTwoProjects()

    const { data, isError } = parseResult(
      await client.callTool({ name: 'memory_crystallize', arguments: { action: 'graph' } })
    )

    expect(isError).toBe(false)
    expect(data.items.map((n: { id: string }) => n.id).sort()).toEqual([scopedId, otherId].sort())
    expect(data.meta.scope).toBeNull()
    expect(data.meta.warnings).toContain('no cwd — the answer spans every project')
  })

  test('a registered cwd restricts the answer and raises no warning', async () => {
    const { scopedId, projectId } = seedTwoProjects()

    const { data, isError } = parseResult(
      await client.callTool({
        name: 'memory_crystallize',
        arguments: { action: 'graph', cwd: CWD }
      })
    )

    expect(isError).toBe(false)
    expect(data.items.map((n: { id: string }) => n.id)).toEqual([scopedId])
    expect(data.meta.scope).toEqual({
      project: projectId,
      project_name: 'ReadScopeProject',
      global: false
    })
    expect(data.meta.warnings).toEqual([])
  })
})
