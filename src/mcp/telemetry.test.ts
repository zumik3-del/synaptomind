import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { config } from '../config'
import { closeDb } from '../db/init'
import { closeLogDb, getLogDb } from '../logging'
import { createTestDb } from '../test/helpers'
import { instrumentServer } from './telemetry'
import { registerAllMemoryTools } from './tools'

// MCP telemetry (task #164): every dispatch through instrumentServer must land
// in thought_telemetry with the canonical HTTP-equivalent route, session-scoped
// prev_tool chaining, and meta.source=mcp — including failing dispatches.
mock.module('../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: () => [new Float32Array(384)],
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

const originalLogDbPath = config.logDbPath

interface TelemetryRow {
  action: string
  tool_name: string
  prev_tool: string | null
  session_id: string | null
  query: string | null
  thought_id: string | null
  latency_ms: number | null
  response_size: number | null
  meta: string | null
}

function useMemoryLogDb(): void {
  closeLogDb()
  config.logDbPath = ':memory:'
}

function telemetryRows(): TelemetryRow[] {
  const db = getLogDb()
  if (!db) throw new Error('log db unavailable')
  return db.query('SELECT * FROM thought_telemetry ORDER BY rowid').all() as TelemetryRow[]
}

function lastRow(): TelemetryRow {
  const rows = telemetryRows()
  const row = rows[rows.length - 1]
  if (!row) throw new Error('no telemetry row written')
  return row
}

type Handler = (args: unknown, extra: { sessionId?: string }) => unknown

/** Minimal McpServer stand-in: records the callback instrumentServer wraps. */
interface FakeServer {
  handlers: Map<string, Handler>
  registerTool(name: string, config: unknown, cb: Handler): unknown
}

function instrumentedServer(): FakeServer {
  const handlers = new Map<string, Handler>()
  const server: FakeServer = {
    handlers,
    registerTool(name, _config, cb) {
      handlers.set(name, cb)
      return {}
    }
  }
  instrumentServer(server as unknown as McpServer)
  return server
}

function registerPassthrough(server: FakeServer, name: string): void {
  server.registerTool(name, {}, async () => ({ ok: true }))
}

async function dispatch(
  server: FakeServer,
  name: string,
  args: unknown,
  sessionId?: string
): Promise<unknown> {
  const handler = server.handlers.get(name)
  if (!handler) throw new Error(`handler not registered: ${name}`)
  return handler(args, { sessionId })
}

interface CanonicalRoute {
  tool: string
  action?: string
  actionType: string
  toolName: string
}

// The canonical HTTP-equivalent routes MCP dispatches must aggregate under
// (src/mcp/telemetry.ts TOOL_ROUTES). Kept as an explicit spec so a mapping
// regression fails loudly instead of silently re-routing telemetry.
const CANONICAL_ROUTES: CanonicalRoute[] = [
  { tool: 'memory_recall', action: 'search', actionType: 'read', toolName: 'search_thoughts' },
  { tool: 'memory_recall', action: 'get', actionType: 'read', toolName: 'get_thought' },
  { tool: 'memory_recall', action: 'context', actionType: 'explore', toolName: 'get_context' },
  { tool: 'memory_recall', action: 'chain', actionType: 'explore', toolName: 'get_chain' },
  { tool: 'memory_recall', action: 'clusters', actionType: 'read', toolName: 'recall_clusters' },
  { tool: 'memory_recall', action: undefined, actionType: 'read', toolName: 'search_thoughts' },
  { tool: 'memory_store', action: 'create', actionType: 'write', toolName: 'create_thought' },
  { tool: 'memory_store', action: 'update', actionType: 'write', toolName: 'update_thought' },
  { tool: 'memory_store', action: 'link', actionType: 'link', toolName: 'link_thoughts' },
  { tool: 'memory_store', action: 'smart_note_create', actionType: 'write', toolName: 'create_smart_note' },
  { tool: 'memory_store', action: 'smart_note_list', actionType: 'read', toolName: 'list_smart_notes' },
  { tool: 'memory_store', action: 'smart_note_eval', actionType: 'read', toolName: 'eval_smart_notes' },
  { tool: 'memory_store', action: 'smart_note_promote', actionType: 'write', toolName: 'promote_smart_note' },
  { tool: 'memory_store', action: 'smart_note_delete', actionType: 'write', toolName: 'delete_smart_note' },
  { tool: 'memory_supersede', action: 'archive', actionType: 'write', toolName: 'archive_thought' },
  { tool: 'memory_supersede', action: 'merge', actionType: 'link', toolName: 'merge_thoughts' },
  { tool: 'memory_status', action: 'slots', actionType: 'read', toolName: 'get_slots' },
  { tool: 'memory_status', action: 'frontier', actionType: 'read', toolName: 'get_frontier' },
  { tool: 'memory_status', action: 'profile', actionType: 'read', toolName: 'get_profile' },
  { tool: 'memory_status', action: 'config', actionType: 'read', toolName: 'get_config' },
  { tool: 'memory_status', action: 'health', actionType: 'read', toolName: 'health_check' },
  { tool: 'memory_status', action: 'edge_suggestions', actionType: 'read', toolName: 'edge_suggestions' },
  { tool: 'memory_status', action: 'cleanup', actionType: 'write', toolName: 'cleanup_archived' },
  { tool: 'memory_status', action: undefined, actionType: 'read', toolName: 'get_slots' },
  { tool: 'memory_manage', action: 'list', actionType: 'read', toolName: 'list_projects' },
  { tool: 'memory_manage', action: 'create', actionType: 'write', toolName: 'create_project' },
  { tool: 'memory_manage', action: 'update', actionType: 'write', toolName: 'update_project' },
  { tool: 'memory_manage', action: 'delete', actionType: 'write', toolName: 'delete_project' },
  { tool: 'memory_manage', action: 'resolve', actionType: 'read', toolName: 'resolve_project' },
  { tool: 'memory_crystallize', action: 'crystallize', actionType: 'write', toolName: 'crystallize' },
  { tool: 'memory_crystallize', action: 'graph', actionType: 'read', toolName: 'get_thought_graph' },
  { tool: 'memory_crystallize', action: 'cluster', actionType: 'write', toolName: 'cluster' },
  { tool: 'memory_crystallize', action: 'auto_cluster', actionType: 'write', toolName: 'auto_cluster' },
  { tool: 'memory_reflect', action: 'reflect', actionType: 'write', toolName: 'reflect_session' },
  { tool: 'memory_reflect', action: 'timeline', actionType: 'read', toolName: 'get_thought_timeline' },
  { tool: 'memory_telemetry', action: 'query', actionType: 'read', toolName: 'query_telemetry' },
  { tool: 'memory_telemetry', action: 'analyze', actionType: 'write', toolName: 'analyze_telemetry' },
  { tool: 'memory_telemetry', action: 'primers', actionType: 'read', toolName: 'list_primers' },
  { tool: 'memory_guide', action: undefined, actionType: 'read', toolName: 'guide' }
]

beforeEach(createTestDb)
beforeEach(useMemoryLogDb)
afterEach(closeDb)

afterAll(() => {
  closeLogDb()
  config.logDbPath = originalLogDbPath
})

describe('canonical tool/action mapping', () => {
  test('each MCP tool/action writes its canonical telemetry row', async () => {
    const server = instrumentedServer()
    for (const name of new Set(CANONICAL_ROUTES.map(r => r.tool))) registerPassthrough(server, name)

    for (const route of CANONICAL_ROUTES) {
      const args = route.action === undefined ? {} : { action: route.action }
      await dispatch(server, route.tool, args, 'matrix')

      const row = lastRow()
      expect({ action: row.action, tool: row.tool_name }).toEqual({
        action: route.actionType,
        tool: route.toolName
      })
      expect(JSON.parse(row.meta ?? '{}').source).toBe('mcp')
    }
  })

  test('unknown action on a multiplexed tool falls back to the MCP tool name', async () => {
    const server = instrumentedServer()
    registerPassthrough(server, 'memory_store')

    await dispatch(server, 'memory_store', { action: 'bogus' }, 's')

    const row = lastRow()
    expect(row.action).toBe('read')
    expect(row.tool_name).toBe('memory_store')
  })

  test('a tool absent from the routing table writes no row', async () => {
    const server = instrumentedServer()
    registerPassthrough(server, 'not_a_real_tool')

    await dispatch(server, 'not_a_real_tool', {}, 's')

    expect(telemetryRows().length).toBe(0)
  })

  test('a tool registered without input schema (undefined args) still maps', async () => {
    const server = instrumentedServer()
    registerPassthrough(server, 'memory_guide')

    await dispatch(server, 'memory_guide', undefined, 's')

    const row = lastRow()
    expect(row.tool_name).toBe('guide')
    expect(row.action).toBe('read')
  })
})

describe('prev_tool session tracking', () => {
  function chainServer(): FakeServer {
    const server = instrumentedServer()
    registerPassthrough(server, 'memory_store')
    registerPassthrough(server, 'memory_recall')
    return server
  }

  test('chains successive dispatches within one session', async () => {
    const server = chainServer()

    await dispatch(server, 'memory_store', { action: 'create' }, 'session-a')
    expect(lastRow().prev_tool).toBeNull()

    await dispatch(server, 'memory_recall', { action: 'search', query: 'q' }, 'session-a')
    expect(lastRow().prev_tool).toBe('create_thought')

    const rows = telemetryRows()
    expect(rows.map(r => r.tool_name)).toEqual(['create_thought', 'search_thoughts'])
    expect(rows.map(r => r.session_id)).toEqual(['session-a', 'session-a'])
  })

  test('keeps dispatch history isolated per session', async () => {
    const server = chainServer()

    await dispatch(server, 'memory_store', { action: 'create' }, 'session-a')
    await dispatch(server, 'memory_recall', { action: 'get', thought_id: 'x' }, 'session-b')
    await dispatch(server, 'memory_recall', { action: 'search', query: 'q' }, 'session-a')

    const rows = telemetryRows()
    expect(rows[0].prev_tool).toBeNull()
    expect(rows[1].prev_tool).toBeNull()
    expect(rows[2].prev_tool).toBe('create_thought')
    expect(rows[1].session_id).toBe('session-b')
  })

  test('uses a default bucket when the transport provides no session id', async () => {
    const server = chainServer()

    await dispatch(server, 'memory_store', { action: 'create' }, undefined)
    await dispatch(server, 'memory_recall', { action: 'search', query: 'q' }, undefined)

    const rows = telemetryRows()
    expect(rows[0].prev_tool).toBeNull()
    expect(rows[1].prev_tool).toBe('create_thought')
    expect(rows[0].session_id).toBeNull()
  })
})

describe('recorded row fields', () => {
  test('meta carries source=mcp and the optional status', async () => {
    const server = instrumentedServer()
    registerPassthrough(server, 'memory_store')

    await dispatch(server, 'memory_store', { action: 'create' }, 's')
    expect(JSON.parse(lastRow().meta ?? '{}')).toEqual({ source: 'mcp' })

    await dispatch(server, 'memory_store', { action: 'update', status: 'active' }, 's')
    expect(JSON.parse(lastRow().meta ?? '{}')).toEqual({ source: 'mcp', status: 'active' })
  })

  test('records query, thought id, latency and a zero response size', async () => {
    const server = instrumentedServer()
    registerPassthrough(server, 'memory_recall')

    await dispatch(server, 'memory_recall', { action: 'search', query: 'needle' }, 's')
    const search = lastRow()
    expect(search.query).toBe('needle')
    expect(search.thought_id).toBeNull()
    expect(search.response_size).toBe(0)
    expect(search.latency_ms).toBeGreaterThanOrEqual(0)

    await dispatch(server, 'memory_recall', { action: 'get', thought_id: 'tid-1' }, 's')
    expect(lastRow().thought_id).toBe('tid-1')

    // source_id/target_id cover the merge/supersede argument shape.
    await dispatch(server, 'memory_recall', { action: 'get', source_id: 'src-1' }, 's')
    expect(lastRow().thought_id).toBe('src-1')

    await dispatch(server, 'memory_recall', { action: 'get', target_id: 'tgt-1' }, 's')
    expect(lastRow().thought_id).toBe('tgt-1')

    // thought_id wins over source_id/target_id.
    await dispatch(
      server,
      'memory_recall',
      { action: 'get', thought_id: 'a', source_id: 'b', target_id: 'c' },
      's'
    )
    expect(lastRow().thought_id).toBe('a')
  })

  test('ignores non-string query/thought_id values', async () => {
    const server = instrumentedServer()
    registerPassthrough(server, 'memory_recall')

    await dispatch(server, 'memory_recall', { action: 'search', query: 42, thought_id: 7 }, 's')

    const row = lastRow()
    expect(row.query).toBeNull()
    expect(row.thought_id).toBeNull()
  })
})

describe('error recording', () => {
  test('records the row when the handler throws, then rethrows', async () => {
    const server = instrumentedServer()
    server.registerTool('memory_store', {}, async () => {
      throw new Error('boom')
    })

    await expect(dispatch(server, 'memory_store', { action: 'create' }, 's')).rejects.toThrow('boom')

    const row = lastRow()
    expect(row.action).toBe('write')
    expect(row.tool_name).toBe('create_thought')
    expect(JSON.parse(row.meta ?? '{}').source).toBe('mcp')
  })

  test('records the row when the handler returns an isError envelope', async () => {
    const server = instrumentedServer()
    server.registerTool('memory_recall', {}, async () => ({ isError: true }))

    await dispatch(server, 'memory_recall', { action: 'get', thought_id: 'missing' }, 's')

    expect(lastRow().tool_name).toBe('get_thought')
  })
})

describe('registerAllMemoryTools wiring', () => {
  test('a real MCP dispatch writes telemetry with the HTTP-equivalent route', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = new McpServer({ name: 'telemetry-test', version: '0.0.0' })
    registerAllMemoryTools(server)
    await server.connect(serverTransport)
    const client = new Client({ name: 'telemetry-client', version: '0.0.0' })
    await client.connect(clientTransport)

    await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: 'telemetry probe' }
    })
    await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: 'telemetry probe' }
    })

    const rows = telemetryRows()
    expect(rows.length).toBe(2)

    expect(rows[0].action).toBe('write')
    expect(rows[0].tool_name).toBe('create_thought')
    expect(JSON.parse(rows[0].meta ?? '{}')).toEqual({ source: 'mcp' })

    expect(rows[1].action).toBe('read')
    expect(rows[1].tool_name).toBe('search_thoughts')
    expect(rows[1].query).toBe('telemetry probe')
    expect(rows[1].prev_tool).toBe('create_thought')

    await client.close()
  })
})
