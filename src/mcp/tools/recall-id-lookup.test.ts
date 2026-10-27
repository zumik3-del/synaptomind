import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getDb } from '../../db/container'
import { createEdge } from '../../db/edges'
import { closeDb } from '../../db/init'
import { createProjectService } from '../../services/projects.service'
import { createTestDb, seedThought } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

/**
 * Task #2186, wire level: `memory_recall action=search` must expose the
 * id-lookup corrections the service layer makes, because an MCP client only
 * ever sees the envelope.
 *
 * Pinned here:
 *
 * - an id-shaped query that addresses nothing falls back to the word search and
 *   leaves an `id_not_found` note in `meta.warnings` (the answer is not empty),
 * - an unknown full UUID keeps the precise `reason: id_not_found` when the
 *   fallback finds nothing either,
 * - an id-addressed superseded thought stays observable: `standing` and
 *   `superseded_by`, even though the agent-facing default is
 *   `supersession_mode=suppress`, while `low_confidence` keeps its retrieval
 *   meaning and stays false on an id hit (task #2190),
 * - the `clusters` action honours its cluster invariant on an id query: a
 *   non-cluster id answers nothing instead of leaking a non-cluster row
 *   (task #2190).
 */

const CWD = '/tmp/t2188-recall-id'

const A = '018f0a00-0000-7000-8000-00000000000a'
const B = '018f0a00-0000-7000-8000-00000000000b'

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

/** Register {@link CWD} so the search scopes to it without an extra warning. */
function projectId(): string {
  return createProjectService({ name: 'RecallIdProject', local_path: CWD }).id
}

beforeEach(createTestDb)
afterEach(closeDb)

beforeAll(async () => {
  client = await setupClient()
})

describe('memory_recall search — id lookup on the wire (task #2186)', () => {
  test('an id-shaped miss falls back to the word search and warns instead of answering empty', async () => {
    const pid = projectId()
    const id = seedThought({ id: A, content: 'release 2025102512345 shipped the fix', project_id: pid })

    const { data, isError } = parseResult(
      await client.callTool({
        name: 'memory_recall',
        arguments: { action: 'search', query: '2025102512345', cwd: CWD, limit: 10 }
      })
    )

    expect(isError).toBe(false)
    expect(data.items.map((item: { thought: { id: string } }) => item.thought.id)).toEqual([id])
    expect(data.meta.warnings.some((w: string) => w.includes('id_not_found'))).toBe(true)
    // Rows came back, so the answer is an ordinary match, not an id miss.
    expect(data.meta.reason).toBeUndefined()
  })

  test('an unknown full UUID reports reason id_not_found plus the warning', async () => {
    projectId()
    seedThought({ id: A, content: 'NEIGHBOUR marker', project_id: 'default' })

    const { data, isError } = parseResult(
      await client.callTool({
        name: 'memory_recall',
        arguments: { action: 'search', query: '018f0a00-0000-7000-8000-0000000000ff', cwd: CWD }
      })
    )

    expect(isError).toBe(false)
    expect(data.items).toEqual([])
    expect(data.meta.warnings.some((w: string) => w.includes('id_not_found'))).toBe(true)
    expect(data.meta.reason).toBe('id_not_found')
  })

  test('a superseded thought addressed by id stays visible and annotated, never suppressed', async () => {
    const pid = projectId()
    const oldId = seedThought({ id: A, content: 'SUPERSEDED_WIRE marker', project_id: pid })
    const newId = seedThought({ id: B, content: 'SUPERSEDING_WIRE marker', project_id: pid })
    createEdge(getDb(), newId, oldId, 'replaces')

    const { data, isError } = parseResult(
      await client.callTool({
        name: 'memory_recall',
        arguments: { action: 'search', query: oldId, cwd: CWD, compact: false, limit: 10 }
      })
    )

    expect(isError).toBe(false)
    // The agent-facing default is supersede-suppress; an explicit id must win.
    expect(data.items).toHaveLength(1)
    const [hit] = data.items
    expect(hit.thought.id).toBe(oldId)
    expect(hit.standing).toBe('superseded')
    expect(hit.superseded_by).toEqual([newId])
    // low_confidence means "weak retrieval" and stays false on an id hit (task
    // #2190): the contested state rides in standing/superseded_by.
    expect(hit.low_confidence).toBe(false)
  })
})

describe('memory_recall clusters — the id lookup honours the cluster invariant (task #2190)', () => {
  test('a non-cluster id answers nothing instead of leaking a non-cluster row', async () => {
    const pid = projectId()
    seedThought({ id: A, content: 'PLAIN_ROW marker', project_id: pid, is_cluster: 0 })

    const { data, isError } = parseResult(
      await client.callTool({
        name: 'memory_recall',
        arguments: { action: 'clusters', query: A, cwd: CWD }
      })
    )

    expect(isError).toBe(false)
    expect(data.items).toEqual([])
    // Nothing survived the cluster filter, so the miss is explained exactly as
    // docs/mcp-tools.md documents it (reason only when the fallback is empty too).
    expect(data.meta.reason).toBe('id_not_found')
  })

  test('a cluster id is answered with its row', async () => {
    const pid = projectId()
    seedThought({ id: B, content: 'CLUSTER_ROW marker', project_id: pid, is_cluster: 1 })

    const { data, isError } = parseResult(
      await client.callTool({
        name: 'memory_recall',
        arguments: { action: 'clusters', query: B, cwd: CWD }
      })
    )

    expect(isError).toBe(false)
    expect(data.items.map((item: { thought: { id: string } }) => item.thought.id)).toEqual([B])
  })
})

describe('memory_recall search — a prefix is project-scoped on the wire (task #2190)', () => {
  test('a prefix shared by two projects resolves only the scoped one', async () => {
    const pid = projectId()
    const mine = seedThought({ id: A, content: 'PREFIX_SCOPED_MINE', project_id: pid })
    seedThought({ id: B, content: 'PREFIX_SCOPED_OTHER', project_id: 'default' })

    const { data, isError } = parseResult(
      await client.callTool({
        name: 'memory_recall',
        arguments: { action: 'search', query: '018f0a0000007', cwd: CWD }
      })
    )

    expect(isError).toBe(false)
    expect(data.items.map((item: { thought: { id: string } }) => item.thought.id)).toEqual([mine])
  })
})
