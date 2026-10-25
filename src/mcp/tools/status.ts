import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerActionTool } from './action-tool'
import { slotsHandler } from './status/slots'
import { frontierHandler } from './status/frontier'
import { configHandler } from './status/config'
import { healthHandler } from './status/health'
import { proposeHandler } from './status/propose'

const handlers = {
  slots: slotsHandler,
  frontier: frontierHandler,
  config: configHandler,
  health: healthHandler,
  propose: proposeHandler
}

export function registerMemoryStatus(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_status',
    description: `Query system state (read-only). Every action answers in one envelope: { items, meta } for collections (slots, frontier) or { item, meta } for single objects (config, health, propose); meta = { action, scope, counts: { total, returned, filtered_out }, degraded, warnings }. cwd is REQUIRED for slots, frontier and propose (it scopes the answer to one project). Actions: slots (read-only; pending_items derived from pending thoughts, architecture_decisions from primers; slots_limit/offset paging), frontier (limit result count, 1-50), config, health, propose (read-only plan).`,
    inputSchema: {
      action: z.enum(['slots', 'frontier', 'config', 'health', 'propose']).describe('Action'),
      names: z.array(z.string()).optional().describe('Filter by slot names. OPTIONAL for "slots". IGNORED for all other actions.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max frontier results (1-50, default 10). OPTIONAL for "frontier". IGNORED for all other actions.'),
      slots_limit: z.number().int().min(1).max(1000).optional().describe('Max pending_items for slots paging (1-1000). OPTIONAL for "slots". IGNORED for all other actions.'),
      offset: z.number().int().min(0).max(1_000_000).optional().describe('Offset for pagination (slots only, pending_items). OPTIONAL for "slots". IGNORED for all other actions.'),
      project_id: z.never({ error: 'project_id was removed; use cwd' }).optional().describe('Removed; use cwd.'),
      cwd: z.string().optional().describe('Working directory — REQUIRED for "slots", "frontier", "propose" (it resolves the project scope reported in meta.scope); a call without it is rejected. IGNORED for "config", "health".'),
      thought_id: z.string().optional().describe('Existing thought to analyse (provide this or content). OPTIONAL for "propose". IGNORED for all other actions.'),
      content: z.string().optional().describe('Draft content to analyse when the thought is not persisted yet (provide this or thought_id). OPTIONAL for "propose". IGNORED for all other actions.'),
      compact: z.boolean().optional().describe('Compact propose output (top 3 edges, no signals). Default true; pass false (or include_signals=true) for full output. OPTIONAL for "propose". IGNORED for all other actions.'),
      max_edges: z.number().int().min(0).optional().describe('Cap the number of proposed edges (maps to engine maxProposals). Default: 3 (slim) unless full output is requested. OPTIONAL for "propose". IGNORED for all other actions.'),
      include_signals: z.boolean().optional().describe('Include per-edge signals in the output. Default false (slim); true restores full output. OPTIONAL for "propose". IGNORED for all other actions.'),
      severity: z.enum(['critical', 'warning', 'info']).optional().describe('Minimum severity. OPTIONAL for "health". IGNORED for all other actions.'),
      include_details: z.boolean().optional().describe('Include per-check detail arrays in the health report (default false). OPTIONAL for "health". IGNORED for all other actions.'),
      fields: z.array(z.string()).optional().describe('Fields to include in output; intersected with available columns. OPTIONAL for all actions. IGNORED for actions without thought output.'),
      // Tombstones for retired parameters: supplying one fails input validation
      // with the canonical replacement instead of a silent strip.
      k: z.never({ error: 'k was removed; use limit' }).optional().describe('Removed; use limit.'),
      fix: z.never({ error: 'fix was removed; use /health-check/repair' }).optional().describe('Removed; use the repair endpoint.'),
    },
    handlers
  })
}
