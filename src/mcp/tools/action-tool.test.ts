import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { closeDb } from '../../db/init'
import { createTestDb, seedThought } from '../../test/helpers'
import { registerAllMemoryTools } from '.'
import { type ActionToolConfig, registerActionTool, requiredString } from './action-tool'
import { registerMemoryRecall } from './recall'
import { registerMemoryStore } from './store'
import { registerMemorySupersede } from './supersede'
import { registerMemoryStatus } from './status'
import { registerMemoryManage } from './manage'
import { registerMemoryCrystallize } from './crystallize'
import { registerMemoryReflect } from './reflect'
import { registerMemoryTelemetry } from './telemetry'

// Coverage for the unified MCP action dispatch (task #169, audit findings
// F8/F9/F18). The dispatcher is shared by all eight action tools, so it is
// exercised both in isolation (synthetic config) and through every real tool
// registration, plus end-to-end over an in-memory MCP client.

mock.module('../../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: () => [new Float32Array(384)],
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

type ToolResult = {
  content: Array<{ type: string; text: string }>
  structuredContent?: { result?: unknown }
  isError?: boolean
}

function parseResult(result: unknown): { text: string; isError: boolean } {
  const r = result as ToolResult
  return { text: r.content?.[0]?.text ?? '', isError: r.isError === true }
}

/** Wrap a register function in a fake server and return the registered callback. */
function captureTool(register: (server: McpServer) => void): (args: Record<string, unknown>) => Promise<unknown> {
  let handler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined
  const fakeServer = {
    registerTool: (_name: string, _config: unknown, cb: (args: Record<string, unknown>) => Promise<unknown>) => {
      handler = cb
      return { enable: () => {}, disable: () => {}, remove: () => {} }
    }
  } as unknown as McpServer
  register(fakeServer)
  if (!handler) throw new Error('register function did not register a tool')
  return handler
}

// ── Dispatcher mechanics (synthetic config) ──────────────────────────────────

const demoConfig: ActionToolConfig = {
  name: 'memory_demo',
  description: 'dispatcher probe',
  inputSchema: { action: z.string() },
  handlers: {
    echo: { run: args => ({ echoed: args.value }) },
    needs_content: {
      input: z.object({ content: requiredString('content is required for create action') }),
      run: () => ({ ok: true })
    },
    passthrough: {
      run: () => ({ content: [{ type: 'text' as const, text: 'raw text' }], structuredContent: { result: 'raw text' } })
    },
    boom: {
      run: () => {
        throw new Error('handler exploded')
      }
    },
    boom_non_error: {
      run: () => {
        throw 'bare string failure'
      }
    }
  }
}

describe('registerActionTool dispatch mechanics', () => {
  test('known action routes to its handler and wraps a plain return in jsonResult', async () => {
    const handler = captureTool(server => registerActionTool(server, demoConfig))
    const result = (await handler({ action: 'echo', value: 42 })) as ToolResult

    expect(result.isError).toBeUndefined()
    expect(result.structuredContent?.result).toEqual({ echoed: 42 })
    expect(JSON.parse(result.content[0].text)).toEqual({ echoed: 42 })
  })

  test('unknown action returns a structured isError envelope naming the action', async () => {
    const handler = captureTool(server => registerActionTool(server, demoConfig))
    const result = (await handler({ action: 'not_a_real_action' })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBe('Unknown action: not_a_real_action')
  })

  test('action-conditional input schema rejects a missing required field', async () => {
    const handler = captureTool(server => registerActionTool(server, demoConfig))
    const result = (await handler({ action: 'needs_content' })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('content is required for create action')
  })

  test('action-conditional input schema rejects an empty required field', async () => {
    const handler = captureTool(server => registerActionTool(server, demoConfig))
    const result = (await handler({ action: 'needs_content', content: '' })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('content is required for create action')
  })

  test('action-conditional input schema accepts a valid field and runs the handler', async () => {
    const handler = captureTool(server => registerActionTool(server, demoConfig))
    const result = (await handler({ action: 'needs_content', content: 'hello' })) as ToolResult

    expect(result.isError).toBeUndefined()
    expect(result.structuredContent?.result).toEqual({ ok: true })
  })

  test('a handler returning a ready-made tool result is passed through unwrapped', async () => {
    const handler = captureTool(server => registerActionTool(server, demoConfig))
    const result = (await handler({ action: 'passthrough' })) as ToolResult

    // isToolResult short-circuit: no re-wrapping into a second envelope.
    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([{ type: 'text', text: 'raw text' }])
    expect(result.structuredContent?.result).toBe('raw text')
  })

  test('a thrown Error is converted to an isError envelope carrying its message', async () => {
    const handler = captureTool(server => registerActionTool(server, demoConfig))
    const result = (await handler({ action: 'boom' })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('handler exploded')
  })

  test('a thrown non-Error falls back to a tool-named failure message', async () => {
    const handler = captureTool(server => registerActionTool(server, demoConfig))
    const result = (await handler({ action: 'boom_non_error' })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('memory_demo failed')
  })
})

// ── Unknown-action handling across every real action tool ────────────────────

const ACTION_REGISTRARS: Array<{ name: string; register: (server: McpServer) => void }> = [
  { name: 'memory_recall', register: registerMemoryRecall },
  { name: 'memory_store', register: registerMemoryStore },
  { name: 'memory_supersede', register: registerMemorySupersede },
  { name: 'memory_status', register: registerMemoryStatus },
  { name: 'memory_manage', register: registerMemoryManage },
  { name: 'memory_crystallize', register: registerMemoryCrystallize },
  { name: 'memory_reflect', register: registerMemoryReflect },
  { name: 'memory_telemetry', register: registerMemoryTelemetry }
]

describe('unknown action is rejected by every registered action tool', () => {
  for (const { name, register } of ACTION_REGISTRARS) {
    test(`${name} returns the dispatcher Unknown action envelope`, async () => {
      const handler = captureTool(register)
      const result = (await handler({ action: 'definitely_not_an_action' })) as ToolResult

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toBe('Unknown action: definitely_not_an_action')
    })
  }
})

// ── End-to-end dispatch over an in-memory MCP client ─────────────────────────

let client: Client

async function setupClient(): Promise<Client> {
  const s = new SdkMcpServer({ name: 'test', version: '0.0.0' })
  registerAllMemoryTools(s)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await s.connect(serverTransport)
  const c = new Client({ name: 'test-client', version: '0.0.0' })
  await c.connect(clientTransport)
  return c
}

beforeEach(createTestDb)
afterEach(closeDb)

beforeAll(async () => {
  client = await setupClient()
})

const KNOWN_ACTION_CASES: Array<{
  label: string
  tool: string
  args: () => Record<string, unknown>
}> = [
  { label: 'memory_recall search', tool: 'memory_recall', args: () => ({ action: 'search', query: 'known action marker' }) },
  { label: 'memory_store smart_note_list', tool: 'memory_store', args: () => ({ action: 'smart_note_list' }) },
  {
    label: 'memory_supersede archive',
    tool: 'memory_supersede',
    args: () => ({ action: 'archive', thought_id: seedThought({ content: 'archive dispatch probe' }) })
  },
  { label: 'memory_status slots', tool: 'memory_status', args: () => ({ action: 'slots' }) },
  { label: 'memory_manage list', tool: 'memory_manage', args: () => ({ action: 'list' }) },
  { label: 'memory_crystallize graph', tool: 'memory_crystallize', args: () => ({ action: 'graph' }) },
  { label: 'memory_reflect timeline', tool: 'memory_reflect', args: () => ({ action: 'timeline' }) },
  { label: 'memory_telemetry primers', tool: 'memory_telemetry', args: () => ({ action: 'primers' }) }
]

describe('known action routes to a handler on every action tool', () => {
  for (const c of KNOWN_ACTION_CASES) {
    test(c.label, async () => {
      const result = await client.callTool({ name: c.tool, arguments: c.args() })
      const { text, isError } = parseResult(result)

      expect(isError).toBe(false)
      expect(text.length).toBeGreaterThan(0)
    })
  }
})

describe('unknown action returns a structured error on every action tool', () => {
  for (const { name } of ACTION_REGISTRARS) {
    test(name, async () => {
      const result = await client.callTool({ name, arguments: { action: 'definitely_not_an_action' } })
      const { text, isError } = parseResult(result)

      expect(isError).toBe(true)
      expect(text.length).toBeGreaterThan(0)
    })
  }
})

// ── Action-conditional required fields through the public surface ────────────

const REQUIRED_FIELD_CASES: Array<{ label: string; tool: string; args: Record<string, unknown>; message: string }> = [
  { label: 'recall get', tool: 'memory_recall', args: { action: 'get' }, message: 'thought_id is required for get action' },
  { label: 'recall search', tool: 'memory_recall', args: { action: 'search' }, message: 'query is required for search action' },
  { label: 'recall context', tool: 'memory_recall', args: { action: 'context' }, message: 'query is required for context action' },
  { label: 'recall chain', tool: 'memory_recall', args: { action: 'chain' }, message: 'thought_id is required for chain action' },
  { label: 'recall clusters', tool: 'memory_recall', args: { action: 'clusters' }, message: 'query is required for clusters action' },
  { label: 'store create', tool: 'memory_store', args: { action: 'create' }, message: 'content is required for create action' },
  { label: 'store update', tool: 'memory_store', args: { action: 'update' }, message: 'thought_id is required for update action' },
  { label: 'store link', tool: 'memory_store', args: { action: 'link' }, message: 'thought_id is required for link action (source)' },
  {
    label: 'store smart_note_create',
    tool: 'memory_store',
    args: { action: 'smart_note_create', thought_id: 'x' },
    message: 'surface_condition is required for smart_note_create action'
  },
  {
    label: 'store smart_note_promote',
    tool: 'memory_store',
    args: { action: 'smart_note_promote' },
    message: 'note_id is required for smart_note_promote action'
  },
  {
    label: 'store smart_note_delete',
    tool: 'memory_store',
    args: { action: 'smart_note_delete' },
    message: 'note_id is required for smart_note_delete action'
  },
  {
    label: 'supersede archive',
    tool: 'memory_supersede',
    args: { action: 'archive' },
    message: 'thought_id is required for archive action'
  },
  {
    label: 'supersede merge',
    tool: 'memory_supersede',
    args: { action: 'merge' },
    message: 'source_id is required for merge action'
  },
  { label: 'manage create', tool: 'memory_manage', args: { action: 'create' }, message: 'name is required for create action' },
  {
    label: 'manage update',
    tool: 'memory_manage',
    args: { action: 'update' },
    message: 'project_id is required for update action'
  },
  {
    label: 'manage delete',
    tool: 'memory_manage',
    args: { action: 'delete' },
    message: 'project_id is required for delete action'
  },
  { label: 'manage resolve', tool: 'memory_manage', args: { action: 'resolve' }, message: 'cwd is required for resolve action' },
  {
    label: 'crystallize cluster',
    tool: 'memory_crystallize',
    args: { action: 'cluster' },
    message: 'thought_ids is required for cluster action'
  },
  {
    label: 'telemetry query',
    tool: 'memory_telemetry',
    args: { action: 'query' },
    message: 'metric is required for query action'
  },
  {
    label: 'telemetry primers delete',
    tool: 'memory_telemetry',
    args: { action: 'primers', primer_action: 'delete' },
    message: 'primer_id required for delete'
  }
]

describe('per-action schemas enforce action-conditional required fields', () => {
  for (const c of REQUIRED_FIELD_CASES) {
    test(c.label, async () => {
      const result = await client.callTool({ name: c.tool, arguments: c.args })
      const { text, isError } = parseResult(result)

      expect(isError).toBe(true)
      expect(text).toContain(c.message)
    })
  }
})

// ── memory_status action=config: raw-text envelope passthrough ───────────────

describe('memory_status action=config raw-text passthrough', () => {
  test('returns the raw config text as both content and structuredContent.result', async () => {
    const result = (await client.callTool({ name: 'memory_status', arguments: { action: 'config' } })) as ToolResult

    expect(result.isError).not.toBe(true)
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    // The handler returns a ready-made tool result, so the dispatcher must not
    // JSON-wrap the text (isToolResult path) and structuredContent must mirror it.
    expect(result.content[0].text).toContain('SynaptoMind Configuration')
    expect(result.structuredContent?.result).toBe(result.content[0].text)
  })
})
