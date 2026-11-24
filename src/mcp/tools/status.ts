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
    description: `Query system state (read-only). Every action answers in one envelope: { items, meta } for collections (slots, frontier) or { item, meta } for single objects (config, health); meta = { action, scope, counts: { total, returned, filtered_out }, degraded, warnings }. cwd is optional for slots and frontier (it scopes the answer to one project); omitting it leaves meta.scope null and is noted in meta.warnings — slots then reads only the global slot rows (the project-scoped overrides are not applied) and frontier answers across every project. Actions: slots (read-only; pending_items derived from pending thoughts, architecture_decisions from primers; slots_limit/offset paging), frontier (limit result count, 1-50), config, health. Every action refuses an argument that belongs to another one.`,
    inputSchema: {
      action: z.enum(['slots', 'frontier', 'config', 'health']).describe('Action'),
      ...STATUS_ARGS
    },
    handlers
  })
}
