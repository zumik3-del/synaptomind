import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { insertTelemetry, type TelemetryInsertOpts } from '../logging'

type TelemetryAction = TelemetryInsertOpts['action']

interface ToolRoute {
  action: TelemetryAction
  toolName: string
}

/**
 * Canonical HTTP-equivalent telemetry routes for each MCP tool action.
 *
 * MCP multiplexes many operations behind action enums, while telemetry
 * aggregates (memory_telemetry, self-improve signals) key on the HTTP tool
 * names (create_thought, search_thoughts, …). Mapping MCP dispatches onto those
 * names keeps MCP activity visible to `thought_telemetry` queries instead of
 * being a blind spot.
 */
const TOOL_ROUTES: Record<string, { default?: ToolRoute; actions?: Record<string, ToolRoute> }> = {
  memory_recall: {
    default: { action: 'read', toolName: 'search_thoughts' },
    actions: {
      search: { action: 'read', toolName: 'search_thoughts' },
      get: { action: 'read', toolName: 'get_thought' },
      context: { action: 'explore', toolName: 'get_context' },
      chain: { action: 'explore', toolName: 'get_chain' },
      clusters: { action: 'read', toolName: 'recall_clusters' }
    }
  },
  memory_store: {
    actions: {
      create: { action: 'write', toolName: 'create_thought' },
      update: { action: 'write', toolName: 'update_thought' },
      link: { action: 'link', toolName: 'link_thoughts' },
      smart_note_create: { action: 'write', toolName: 'create_smart_note' },
      smart_note_list: { action: 'read', toolName: 'list_smart_notes' },
      smart_note_eval: { action: 'read', toolName: 'eval_smart_notes' },
      smart_note_promote: { action: 'write', toolName: 'promote_smart_note' },
      smart_note_delete: { action: 'write', toolName: 'delete_smart_note' }
    }
  },
  memory_supersede: {
    actions: {
      archive: { action: 'write', toolName: 'archive_thought' },
      merge: { action: 'link', toolName: 'merge_thoughts' }
    }
  },
  memory_status: {
    default: { action: 'read', toolName: 'get_slots' },
    actions: {
      slots: { action: 'read', toolName: 'get_slots' },
      frontier: { action: 'read', toolName: 'get_frontier' },
      profile: { action: 'read', toolName: 'get_profile' },
      config: { action: 'read', toolName: 'get_config' },
      health: { action: 'read', toolName: 'health_check' },
      edge_suggestions: { action: 'read', toolName: 'edge_suggestions' },
      cleanup: { action: 'write', toolName: 'cleanup_archived' }
    }
  },
  memory_manage: {
    actions: {
      list: { action: 'read', toolName: 'list_projects' },
      create: { action: 'write', toolName: 'create_project' },
      update: { action: 'write', toolName: 'update_project' },
      delete: { action: 'write', toolName: 'delete_project' },
      resolve: { action: 'read', toolName: 'resolve_project' }
    }
  },
  memory_crystallize: {
    actions: {
      crystallize: { action: 'write', toolName: 'crystallize' },
      graph: { action: 'read', toolName: 'get_thought_graph' },
      cluster: { action: 'write', toolName: 'cluster' },
      auto_cluster: { action: 'write', toolName: 'auto_cluster' }
    }
  },
  memory_reflect: {
    actions: {
      reflect: { action: 'write', toolName: 'reflect_session' },
      timeline: { action: 'read', toolName: 'get_thought_timeline' }
    }
  },
  memory_telemetry: {
    actions: {
      query: { action: 'read', toolName: 'query_telemetry' },
      analyze: { action: 'write', toolName: 'analyze_telemetry' },
      primers: { action: 'read', toolName: 'list_primers' }
    }
  },
  memory_guide: {
    default: { action: 'read', toolName: 'guide' }
  }
}

// Tools without an inputSchema receive `undefined` args from the SDK.
type LooseArgs = Record<string, unknown> | undefined
type LooseHandler = (args: LooseArgs, extra: { sessionId?: string }) => unknown

function resolveRoute(name: string, args: Record<string, unknown>): ToolRoute | undefined {
  const entry = TOOL_ROUTES[name]
  if (!entry) return undefined
  const action = typeof args.action === 'string' ? args.action : undefined
  return (action ? entry.actions?.[action] : undefined) ?? entry.default ?? { action: 'read', toolName: name }
}

function readThoughtId(args: Record<string, unknown>): string | undefined {
  for (const key of ['thought_id', 'source_id', 'target_id']) {
    const value = args[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

interface RecordContext {
  name: string
  args: LooseArgs
  sessionId?: string
  latencyMs: number
  lastToolBySession: Map<string, string>
}

function recordMcpTelemetry({ name, args, sessionId, latencyMs, lastToolBySession }: RecordContext): void {
  const safeArgs = args ?? {}
  const route = resolveRoute(name, safeArgs)
  if (!route) return

  // prev_tool carries the session's in-process dispatch history, so telemetry
  // aggregates (search→create grounding, orphan writes) see MCP tool chains.
  const sessionKey = sessionId ?? 'default'
  const prevTool = lastToolBySession.get(sessionKey)
  lastToolBySession.set(sessionKey, route.toolName)

  const status = safeArgs.status
  insertTelemetry({
    action: route.action,
    toolName: route.toolName,
    prevTool,
    sessionId,
    query: typeof safeArgs.query === 'string' ? safeArgs.query : undefined,
    thoughtId: readThoughtId(safeArgs),
    latencyMs: Math.round(latencyMs),
    responseSize: 0,
    meta: { source: 'mcp', ...(typeof status === 'string' ? { status } : {}) }
  })
}

function wrapHandler(name: string, cb: LooseHandler, lastToolBySession: Map<string, string>): LooseHandler {
  return async (args, extra) => {
    const started = performance.now()
    try {
      return await cb(args, extra)
    } finally {
      recordMcpTelemetry({ name, args, sessionId: extra?.sessionId, latencyMs: performance.now() - started, lastToolBySession })
    }
  }
}

/**
 * MCP telemetry middleware: wraps every tool registered on `server` so each
 * dispatch writes the same `thought_telemetry` row the HTTP API writes via
 * `withTelemetry` (plus prev_tool/session context). Install it before
 * registering tools; the wrapper is per-server to keep session history isolated.
 */
export function instrumentServer(server: McpServer): void {
  const lastToolBySession = new Map<string, string>()
  const original = server.registerTool.bind(server)
  const instrumented = (name: string, config: Record<string, unknown>, cb: unknown): RegisteredTool => {
    if (typeof cb !== 'function') return original(name, config as never, cb as never)
    return original(name, config as never, wrapHandler(name, cb as LooseHandler, lastToolBySession) as never)
  }
  server.registerTool = instrumented as unknown as typeof server.registerTool
}
