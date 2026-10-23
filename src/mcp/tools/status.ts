import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerActionTool } from './action-tool'
import { slotsHandler } from './status/slots'
import { frontierHandler } from './status/frontier'
import { configHandler } from './status/config'
import { healthHandler } from './status/health'
import { proposeHandler } from './status/propose'
import { cleanupHandler } from './status/cleanup'

const handlers = {
  slots: slotsHandler,
  frontier: frontierHandler,
  config: configHandler,
  health: healthHandler,
  propose: proposeHandler,
  cleanup: cleanupHandler
}

export function registerMemoryStatus(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_status',
    description: `Query system state (read-only except cleanup). Actions: slots (read-only; pending_items derived from pending thoughts, architecture_decisions from primers; slots_limit/offset paging), frontier (limit result count, 1-50), config, health, propose (read-only plan), cleanup (TTL; confirm to execute, otherwise preview).`,
    inputSchema: {
      action: z.enum(['slots', 'frontier', 'config', 'health', 'propose', 'cleanup']).describe('Action'),
      names: z.array(z.string()).optional().describe('Filter by slot names. OPTIONAL for "slots". IGNORED for all other actions.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max frontier results (1-50, default 10). OPTIONAL for "frontier". IGNORED for all other actions.'),
      slots_limit: z.number().int().min(1).max(1000).optional().describe('Max pending_items for slots paging (1-1000). OPTIONAL for "slots". IGNORED for all other actions.'),
      offset: z.number().int().min(0).max(1_000_000).optional().describe('Offset for pagination (slots only, pending_items). OPTIONAL for "slots". IGNORED for all other actions.'),
      project_id: z.string().optional().describe('Filter by project. OPTIONAL for "slots", "frontier", "propose". IGNORED for "config", "health", "cleanup".'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project. OPTIONAL for "slots", "frontier", "propose". IGNORED for "config", "health", "cleanup".'),
      thought_id: z.string().optional().describe('Existing thought to analyse (provide this or content). OPTIONAL for "propose". IGNORED for all other actions.'),
      content: z.string().optional().describe('Draft content to analyse when the thought is not persisted yet (provide this or thought_id). OPTIONAL for "propose". IGNORED for all other actions.'),
      severity: z.enum(['critical', 'warning', 'info']).optional().describe('Minimum severity. OPTIONAL for "health". IGNORED for all other actions.'),
      fix: z.boolean().optional().describe('Auto-fix safe issues. OPTIONAL for "health". IGNORED for all other actions.'),
      confirm: z.boolean().optional().describe('CONSUMED by "cleanup" (true executes; false/omitted previews). IGNORED for all other actions.'),
      // Tombstones for retired parameters: supplying one fails input validation
      // with the canonical replacement instead of a silent strip.
      k: z.never({ error: 'k was removed; use limit' }).optional().describe('Removed; use limit.'),
      dry_run: z.never({ error: 'dry_run was removed; use confirm' }).optional().describe('Removed; use confirm.'),
    },
    handlers
  })
}
