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
    description: `Query system state (read-only except cleanup). Actions: slots (read-only; pending_items derived from pending thoughts, architecture_decisions from primers; limit/offset paging), frontier (limit result count), config, health, propose (read-only plan), cleanup (TTL; confirm to execute, otherwise preview).`,
    inputSchema: {
      action: z.enum(['slots', 'frontier', 'config', 'health', 'propose', 'cleanup']).describe('Action'),
      names: z.array(z.string()).optional().describe('Filter by slot names (slots only)'),
      limit: z.number().int().min(1).max(1000).optional().describe('Max items (slots pending_items pagination; frontier max results 1-50, default 10)'),
      offset: z.number().int().min(0).max(1_000_000).optional().describe('Offset for pagination (slots only, pending_items)'),
      project_id: z.string().optional().describe('Filter by project (slots/frontier/propose only)'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project (slots/frontier/propose only)'),
      thought_id: z.string().optional().describe('Existing thought to analyse (propose only; provide this or content)'),
      content: z.string().optional().describe('Draft content to analyse when the thought is not persisted yet (propose only; provide this or thought_id)'),
      severity: z.enum(['critical', 'warning', 'info']).optional().describe('Minimum severity (health only)'),
      fix: z.boolean().optional().describe('Auto-fix safe issues (health only)'),
      confirm: z.boolean().optional().describe('Execute cleanup deletion (cleanup only). Defaults to false; set true to delete.')
    },
    handlers
  })
}
