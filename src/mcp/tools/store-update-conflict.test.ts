import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { closeDb } from '../../db/init'
import { getThoughtByIdService } from '../../services/thoughts.service'
import { createThoughtWithUrlLinksService } from '../../services/url_links.service'
import { createTestDb } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

interface ToolErrorEnvelope {
  content: Array<{ type: string; text: string }>
  structuredContent?: {
    result?: { error?: { message: string; statusCode?: number; retryable?: boolean } }
  }
  isError?: boolean
}

interface ToolEnvelope {
  content: Array<{ type: string; text: string }>
  structuredContent?: {
    result?: { item?: Record<string, unknown>; meta?: Record<string, unknown> }
  }
  isError?: boolean
}

let client: Client

beforeEach(createTestDb)
afterEach(closeDb)

beforeAll(async () => {
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerAllMemoryTools(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: 'test-client', version: '0.0.0' })
  await client.connect(clientTransport)
})

async function updateThought(thoughtId: string, content: string): Promise<ToolErrorEnvelope> {
  return (await client.callTool({
    name: 'memory_store',
    arguments: { action: 'update', thought_id: thoughtId, content }
  })) as unknown as ToolErrorEnvelope
}

async function updateThoughtWith(args: Record<string, unknown>): Promise<ToolEnvelope> {
  return (await client.callTool({
    name: 'memory_store',
    arguments: { action: 'update', ...args }
  })) as unknown as ToolEnvelope
}

async function archive(args: Record<string, unknown>): Promise<ToolEnvelope> {
  return (await client.callTool({
    name: 'memory_supersede',
    arguments: { action: 'archive', ...args }
  })) as unknown as ToolEnvelope
}

test('memory_store update onto live content returns a 409 envelope on every attempt', async () => {
  const holder = createThoughtWithUrlLinksService({ content: 'content already in use' })
  const target = createThoughtWithUrlLinksService({ content: 'my own content' })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await updateThought(target.id, 'content already in use')
    expect(result.isError).toBe(true)
    expect(result.structuredContent?.result?.error?.statusCode).toBe(409)
    expect(result.structuredContent?.result?.error?.message).toContain(holder.id)
    expect(result.content[0]?.text).toContain(holder.id)
  }

  expect(getThoughtByIdService(target.id)?.content).toBe('my own content')
  expect(getThoughtByIdService(holder.id)?.content).toBe('content already in use')
})

test('memory_store update to unique content still succeeds', async () => {
  const thought = createThoughtWithUrlLinksService({ content: 'ordinary content' })

  const edited = await updateThought(thought.id, 'rewritten content')
  expect(edited.isError).toBeFalsy()
  expect(getThoughtByIdService(thought.id)?.content).toBe('rewritten content')
})

test('an unknown status answers the generic enum error instead of the archive detour', async () => {
  const thought = createThoughtWithUrlLinksService({ content: 'status probe', status: 'active' })

  const rejected = (await updateThoughtWith({
    thought_id: thought.id,
    status: 'bogus'
  })) as unknown as ToolErrorEnvelope
  expect(rejected.isError).toBe(true)
  const message = rejected.content[0]?.text ?? ''
  expect(message).toContain('Invalid option: expected one of')
  expect(message).toContain('"draft"')
  expect(message).toContain('"active"')
  expect(message).not.toContain('memory_supersede')
  expect(rejected.structuredContent).toBeUndefined()
  expect(getThoughtByIdService(thought.id)?.status).toBe('active')
})

test('the split schema still accepts both writable statuses', async () => {
  const thought = createThoughtWithUrlLinksService({
    content: 'status happy path',
    status: 'active'
  })

  for (const status of ['draft', 'active']) {
    const updated = await updateThoughtWith({ thought_id: thought.id, status })
    expect(updated.isError).toBeFalsy()
    expect(getThoughtByIdService(thought.id)?.status).toBe(status)
  }
})

test('memory_store update to archived is rejected and names the supersede path', async () => {
  const thought = createThoughtWithUrlLinksService({ content: 'stays around', status: 'active' })

  const rejected = (await updateThoughtWith({
    thought_id: thought.id,
    status: 'archived'
  })) as unknown as ToolErrorEnvelope
  expect(rejected.isError).toBe(true)
  expect(rejected.content[0]?.text).toContain('memory_supersede action=archive')
  expect(rejected.content[0]?.text).not.toContain('Invalid option')
  expect(rejected.structuredContent).toBeUndefined()
  expect(getThoughtByIdService(thought.id)?.status).toBe('active')
})

test('a rejected status=archived update writes neither the status nor the bundled content', async () => {
  const thought = createThoughtWithUrlLinksService({
    content: 'original content',
    status: 'active'
  })

  const rejected = await updateThoughtWith({
    thought_id: thought.id,
    content: 'replacement content',
    status: 'archived'
  })
  expect(rejected.isError).toBe(true)
  expect(rejected.content[0]?.text).toContain('memory_supersede action=archive')

  const stored = getThoughtByIdService(thought.id)
  expect(stored?.content).toBe('original content')
  expect(stored?.status).toBe('active')
})

test('memory_supersede archive is the path a rejected update points at', async () => {
  const thought = createThoughtWithUrlLinksService({ content: 'archive me', status: 'active' })

  const preview = await archive({ thought_id: thought.id })
  expect(preview.isError).toBeFalsy()
  expect(preview.structuredContent?.result?.item).toMatchObject({
    status: 'preview',
    current_status: 'active',
    outcome: 'would_archive'
  })
  const token = preview.structuredContent?.result?.item?.preview_token as string | undefined
  expect(typeof token).toBe('string')
  expect(getThoughtByIdService(thought.id)?.status).toBe('active')

  const executed = await archive({ thought_id: thought.id, confirm: true, preview_token: token })
  expect(executed.isError).toBeFalsy()
  expect(executed.structuredContent?.result?.item).toMatchObject({
    status: 'executed',
    result: { id: thought.id, status: 'archived' }
  })
  expect(getThoughtByIdService(thought.id)?.status).toBe('archived')

  const again = await archive({ thought_id: thought.id })
  expect(again.structuredContent?.result?.item).toMatchObject({
    outcome: 'already_archived',
    current_status: 'archived'
  })
  const missing = await archive({ thought_id: 'no-such-thought' })
  expect(missing.isError).toBeFalsy()
  expect(missing.structuredContent?.result?.item).toMatchObject({
    outcome: 'not_found',
    current_status: null
  })
})
