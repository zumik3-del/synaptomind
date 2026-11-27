import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { getDb } from '../../db'
import { closeDb } from '../../db/init'
import { createProject, getDefaultProjectId } from '../../db/projects'
import { createTestDb } from '../../test/helpers'
import { readEnvelopeScope, writeEnvelopeScope } from './envelope'
import { resolveProjectId } from './utils'
import { registerAllMemoryTools } from '.'

const KNOWN = '/work/scope-parity'
const UNKNOWN = '/work/not-a-registered-project'

let client: Client

async function connectClient(): Promise<Client> {
  const server = new McpServer({ name: 'scope-parity-test', version: '1.0.0' })
  registerAllMemoryTools(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const created = new Client({ name: 'test-client', version: '1.0.0' })
  await created.connect(clientTransport)
  return created
}

function silentWarnings(): ReturnType<typeof spyOn> {
  return spyOn(console, 'warn').mockImplementation(() => {})
}

beforeEach(createTestDb)
afterEach(async () => {
  await client?.close()
  closeDb()
})

describe('read and write scope resolution — one resolver, four cases', () => {
  test('a registered cwd resolves to that project in both directions', () => {
    const project = createProject(getDb(), { name: 'ScopeParity', local_path: KNOWN })

    const read = readEnvelopeScope(KNOWN)
    const write = writeEnvelopeScope(KNOWN)

    expect(read.projectId).toBe(project.id)
    expect(read.scope).toEqual({ project: project.id, project_name: 'ScopeParity', global: false })
    expect(write.scope).toEqual(read.scope)
    expect(read.warnings).toEqual([])
    expect(write.warnings).toEqual([])
  })

  test('an unregistered read cwd widens the answer and warns about it', () => {
    const read = readEnvelopeScope(UNKNOWN)

    expect(read.scope).toEqual({ project: null, project_name: null, global: true })
    expect(read.projectId).toBeUndefined()
    expect(read.warnings).toHaveLength(1)
    expect(read.warnings[0]).toContain(UNKNOWN)
    expect(read.warnings[0]).toContain(
      'the answer spans every project (check it with memory_projects'
    )
  })

  test('an unregistered write cwd keeps the global scope as its only trace, with no warning', () => {
    const write = writeEnvelopeScope(UNKNOWN)

    expect(write.scope).toEqual({ project: null, project_name: null, global: true })
    expect(write.warnings).toEqual([])
  })

  test('an absent cwd is no scope at all, and only the read side names the widening', () => {
    for (const cwd of [undefined, '', '   ', 42, null]) {
      expect(writeEnvelopeScope(cwd)).toEqual({ scope: null, warnings: [] })
    }

    const read = readEnvelopeScope(undefined)
    expect(read.scope).toBeNull()
    expect(read.projectId).toBeUndefined()
    expect(read.warnings).toEqual(['no cwd — the answer spans every project'])
    expect(readEnvelopeScope('  ').warnings).toEqual(['no cwd — the answer spans every project'])
  })

  test('the envelope scope helpers never warn: the widening note travels in meta.warnings', () => {
    const warn = silentWarnings()
    try {
      readEnvelopeScope(UNKNOWN)
      readEnvelopeScope(undefined)
      writeEnvelopeScope(UNKNOWN)
      expect(resolveProjectId(UNKNOWN)).toBeUndefined()
      expect(resolveProjectId(undefined)).toBeUndefined()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test('resolveProjectId answers the same project id the envelope scope reports', () => {
    const project = createProject(getDb(), { name: 'ScopeParityIds', local_path: KNOWN })

    expect(resolveProjectId(KNOWN)).toBe(project.id)
    expect(resolveProjectId(KNOWN)).toBe(readEnvelopeScope(KNOWN).projectId)
  })
})

describe('a write with an unregistered cwd lands in the default project', () => {
  test('memory_store create reports the global scope, warns nothing and stores in Default', async () => {
    client = await connectClient()
    const defaultProjectId = getDefaultProjectId(getDb())

    const result = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'scopeless write', cwd: UNKNOWN }
    })
    const response = result as { content: Array<{ text: string }>; isError?: boolean }
    const data = JSON.parse(response.content[0].text)

    expect(response.isError).toBeFalsy()
    expect(data.meta.scope).toEqual({ project: null, project_name: null, global: true })
    expect(data.meta.warnings).toEqual([])

    const row = getDb().prepare('SELECT project_id FROM thoughts WHERE id = ?').get(data.item.id) as
      | { project_id: string }
      | undefined
    expect(row?.project_id).toBe(defaultProjectId as string)
  })
})
