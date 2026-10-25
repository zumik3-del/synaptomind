import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getDb } from '../../db/container'
import { closeDb } from '../../db/init'
import { insertProposal } from '../../db/placement-proposals'
import { createProjectService, resolveProjectService } from '../../services/projects.service'
import { createTestDb, seedThought } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

/**
 * Task #2187, wire level: the read actions that accept an optional `cwd`
 * (`memory_crystallize action=graph`, `edge_review action=list`) must say when
 * they answer across every project instead of silently widening the answer.
 *
 * The review round found the two actions reading globally with no trace in
 * `meta`; this file pins the two halves of the fix:
 *
 * - without `cwd` the envelope carries `scope: null` and a warning that the
 *   answer spans every project (with every project's rows, not one project's),
 * - with a registered `cwd` the scope is that project and no warning is raised
 *   while the answer really is restricted to it.
 *
 * Neither action reaches the embedder, so no embedder mock is needed here.
 */

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

/** Register {@link CWD} and seed one active thought in that project plus one elsewhere. */
function seedTwoProjects(): { scopedId: string; otherId: string; projectId: string } {
  const project = createProjectService({ name: 'ReadScopeProject', local_path: CWD })
  return {
    projectId: project.id,
    scopedId: seedThought({ content: 'SCOPED_READ marker', project_id: project.id }),
    otherId: seedThought({ content: 'OTHER_PROJECT_READ marker', project_id: 'default' })
  }
}

function seedPendingProposal(projectId: string, sourceId: string, targetId: string, fingerprint: string): void {
  insertProposal(getDb(), {
    project_id: projectId,
    source_thought_id: sourceId,
    item_kind: 'edge',
    target_id: targetId,
    edge_type: 'related',
    confidence: 0.8,
    rationale: 'read-scope-warnings fixture',
    payload: '{}',
    fingerprint
  })
}

describe('memory_crystallize action=graph — scope is reported', () => {
  test('a cwd-less call answers every project with scope null and a warning', async () => {
    const { scopedId, otherId } = seedTwoProjects()

    const { data, isError } = parseResult(
      await client.callTool({ name: 'memory_crystallize', arguments: { action: 'graph' } })
    )

    expect(isError).toBe(false)
    // Both projects' nodes are in the answer — the widening is real...
    expect(data.items.map((n: { id: string }) => n.id).sort()).toEqual([scopedId, otherId].sort())
    // ...and it is declared instead of happening silently.
    expect(data.meta.scope).toBeNull()
    expect(data.meta.warnings).toContain('no cwd — the answer spans every project')
  })

  test('a registered cwd restricts the answer and raises no warning', async () => {
    const { scopedId, projectId } = seedTwoProjects()

    const { data, isError } = parseResult(
      await client.callTool({ name: 'memory_crystallize', arguments: { action: 'graph', cwd: CWD } })
    )

    expect(isError).toBe(false)
    expect(data.items.map((n: { id: string }) => n.id)).toEqual([scopedId])
    expect(data.meta.scope).toEqual({ project: projectId, project_name: 'ReadScopeProject', global: false })
    expect(data.meta.warnings).toEqual([])
  })
})

describe('edge_review action=list — scope is reported', () => {
  test('a cwd-less call answers every project with scope null and a warning', async () => {
    const { scopedId, otherId, projectId } = seedTwoProjects()
    const extra = seedThought({ content: 'PROPOSAL_TARGET marker', project_id: 'default' })
    seedPendingProposal(projectId, scopedId, scopedId, 'fp-scoped')
    seedPendingProposal('default', otherId, extra, 'fp-other')

    const { data, isError } = parseResult(
      await client.callTool({ name: 'edge_review', arguments: { action: 'list' } })
    )

    expect(isError).toBe(false)
    expect(data.items).toHaveLength(2)
    expect(data.meta.scope).toBeNull()
    expect(data.meta.warnings).toContain('no cwd — the answer spans every project')
  })

  test('a registered cwd restricts the answer and raises no warning', async () => {
    const { scopedId, otherId, projectId } = seedTwoProjects()
    const extra = seedThought({ content: 'PROPOSAL_TARGET marker', project_id: 'default' })
    seedPendingProposal(projectId, scopedId, scopedId, 'fp-scoped')
    seedPendingProposal('default', otherId, extra, 'fp-other')
    const project = resolveProjectService(CWD)

    const { data, isError } = parseResult(
      await client.callTool({ name: 'edge_review', arguments: { action: 'list', cwd: CWD } })
    )

    expect(isError).toBe(false)
    expect(data.items).toHaveLength(1)
    expect(data.items[0].project_id).toBe(projectId)
    expect(data.meta.scope).toEqual({ project: project!.id, project_name: project!.name, global: false })
    expect(data.meta.warnings).toEqual([])
  })
})
