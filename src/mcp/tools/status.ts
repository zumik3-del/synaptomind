import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerActionTool } from './action-tool'
import { slotsHandler } from './status/slots'
import { frontierHandler } from './status/frontier'
import { profileHandler } from './status/profile'
import { configHandler } from './status/config'
import { healthHandler } from './status/health'
import { edgeSuggestionsHandler } from './status/edge-suggestions'
import { proposeHandler } from './status/propose'
import { cleanupHandler } from './status/cleanup'

const handlers = {
  slots: slotsHandler,
  frontier: frontierHandler,
  profile: profileHandler,
  config: configHandler,
  health: healthHandler,
  edge_suggestions: edgeSuggestionsHandler,
  propose: proposeHandler,
  cleanup: cleanupHandler
}

export function registerMemoryStatus(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_status',
    description: `Query system state. Actions:
- slots: Get context slots (persona, pending_items, architecture_decisions, project_context, active_goals)
- frontier: Get "what to do next" ranking
- profile: Get user profile stats and thoughts
- config: Show current configuration with defaults and env vars
- health: Audit graph health (broken links, orphans, duplicates, structural issues)
- edge_suggestions: Propose unconfirmed \`related\` candidate pairs from embedding similarity (read-only; never implies conflict; confirm via memory_store action=link)
- propose: Propose a read-only placement/link plan for one thought (placement, edge proposals, lifecycle); confirm via memory_store action=link, memory_supersede, memory_crystallize
- cleanup: Preview expired archived thoughts based on TTL config (dry-run by default; pass dry_run=false to delete)`,
    inputSchema: {
      action: z.enum(['slots', 'frontier', 'profile', 'config', 'health', 'edge_suggestions', 'propose', 'cleanup']).describe('Action'),
      names: z.array(z.string()).optional().describe('Filter by slot names (slots only)'),
      project_id: z.string().optional().describe('Filter by project (slots/frontier/edge_suggestions/propose only)'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project (slots/frontier/edge_suggestions/propose only)'),
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
