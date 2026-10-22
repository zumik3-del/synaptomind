import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerActionTool } from './action-tool'
import { slotsHandler } from './status/slots'
import { frontierHandler } from './status/frontier'
import { profileHandler } from './status/profile'
import { configHandler } from './status/config'
import { healthHandler } from './status/health'
import { proposeHandler } from './status/propose'
import { cleanupHandler } from './status/cleanup'

const handlers = {
  slots: slotsHandler,
  frontier: frontierHandler,
  profile: profileHandler,
  config: configHandler,
  health: healthHandler,
  propose: proposeHandler,
  cleanup: cleanupHandler
}

export function registerMemoryStatus(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_status',
    description: `Query system state. Actions: slots (persona, pending_items w/ limit/offset, architecture_decisions, project_context, active_goals), frontier, profile, config, health, propose (read-only plan), cleanup (TTL; dry-run default).`,
    inputSchema: {
      action: z.enum(['slots', 'frontier', 'profile', 'config', 'health', 'propose', 'cleanup']).describe('Action'),
      names: z.array(z.string()).optional().describe('Filter by slot names (slots only)'),
      limit: z.number().int().min(1).max(1000).optional().describe('Max items (slots only, pending_items pagination)'),
      offset: z.number().int().min(0).max(1_000_000).optional().describe('Offset for pagination (slots only, pending_items)'),
      project_id: z.string().optional().describe('Filter by project (slots/frontier/propose only)'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project (slots/frontier/propose only)'),
      thought_id: z.string().optional().describe('Existing thought to analyse (propose only; provide this or content)'),
      content: z.string().optional().describe('Draft content to analyse when the thought is not persisted yet (propose only; provide this or thought_id)'),
      k: z.number().int().min(1).max(50).optional().describe('Max results (default 10, 1-50; frontier only)'),
      severity: z.enum(['critical', 'warning', 'info']).optional().describe('Minimum severity (health only)'),
      fix: z.boolean().optional().describe('Auto-fix safe issues (health only)'),
      dry_run: z.boolean().optional().describe('Preview without deleting (cleanup only). Defaults to true; set false to actually delete.')
    },
    handlers
  })
}
