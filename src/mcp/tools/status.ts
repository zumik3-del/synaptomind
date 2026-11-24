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
    description: `Read-only system state — what the store holds and how it is configured, not the thoughts (memory_recall) or their writes (memory_store). Actions: slots (project_context and active_goals as stored rows; pending_items derived from pending thoughts, architecture_decisions from primers), frontier (next actions ranked, limit 1-50), config, health. cwd is optional for slots and frontier: it scopes to one project, and omitted it leaves meta.scope null with a meta.warnings note — slots then reads only the global rows (project overrides unapplied) and frontier answers across every project. Answers { items, meta } for slots and frontier, { item, meta } for config and health, with meta = { action, scope, counts: { total, returned, filtered_out }, degraded, warnings }. Actions accept only their own arguments.`,
    inputSchema: {
      action: z.enum(['slots', 'frontier', 'config', 'health']).describe('Action'),
      ...STATUS_ARGS
    },
    handlers
  })
}
