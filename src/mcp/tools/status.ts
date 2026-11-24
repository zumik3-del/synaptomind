import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import { READ_ONLY, registerActionTool } from './action-tool'
import { slotsHandler } from './status/slots'
import { frontierHandler } from './status/frontier'
import { configHandler } from './status/config'
import { healthHandler } from './status/health'
import { STATUS_ARGS } from './status/args'

const handlers = {
  slots: slotsHandler,
  frontier: frontierHandler,
  config: configHandler,
  health: healthHandler
}

export function registerMemoryStatus(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_status',
    annotations: READ_ONLY,
    description: `Query system state (read-only). One envelope: { items, meta } for slots and frontier, { item, meta } for config and health; meta = { action, scope, counts: { total, returned, filtered_out }, degraded, warnings }. cwd is optional for slots and frontier: it scopes to one project, and omitted it leaves meta.scope null with a meta.warnings note — slots then reads only the global rows (project overrides unapplied) and frontier answers across every project. Actions: slots (pending_items derived from pending thoughts, architecture_decisions from primers; slots_limit/offset paging), frontier (limit 1-50), config, health. Every action refuses an argument that belongs to another one.`,
    inputSchema: {
      action: z.enum(['slots', 'frontier', 'config', 'health']).describe('Action'),
      ...STATUS_ARGS
    },
    handlers
  })
}
