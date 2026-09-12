import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getSlots } from '../../services/slots.service'
import { getFrontier } from '../../services/frontier.service'
import { getProfileService } from '../../services/profile.service'
import { buildConfigDisplay } from '../../services/config-display.service'
import { runHealthCheck } from '../../services/health-check.service'
import { detectEdgeProposals } from '../../services/edge-detect.service'
import { cleanupArchivedThoughts } from '../../services/ttl-cleanup.service'
import { resolveProjectId } from './utils'
import { registerActionTool, type ActionArgs } from './action-tool'

const handlers = {
  slots: {
    run(args: ActionArgs) {
      const projectFilter = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
      return getSlots({ names: args.names as string[] | undefined, projectId: projectFilter })
    }
  },

  frontier: {
    run(args: ActionArgs) {
      const projectFilter = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
      return getFrontier({ project_id: projectFilter, k: args.k as number | undefined })
    }
  },

  profile: {
    run() {
      const { stats, thoughts } = getProfileService()
      return { stats, thoughts }
    }
  },

  config: {
    run() {
      const text = buildConfigDisplay()
      return { content: [{ type: 'text' as const, text }], structuredContent: { result: text } }
    }
  },

  health: {
    run(args: ActionArgs) {
      return runHealthCheck({ severity: args.severity as 'critical' | 'warning' | 'info' | undefined, fix: args.fix as boolean | undefined })
    }
  },

  edge_suggestions: {
    async run(args: ActionArgs) {
      const projectFilter = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
      return detectEdgeProposals({ projectId: projectFilter })
    }
  },

  cleanup: {
    run(args: ActionArgs) {
      return cleanupArchivedThoughts((args.dry_run as boolean | undefined) ?? true)
    }
  }
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
- edge_suggestions: Detect potential contradicts/supports candidates (read-only; confirm via memory_store action=link)
- cleanup: Preview expired archived thoughts based on TTL config (dry-run by default; pass dry_run=false to delete)`,
    inputSchema: {
      action: z.enum(['slots', 'frontier', 'profile', 'config', 'health', 'edge_suggestions', 'cleanup']).describe('Action'),
      names: z.array(z.string()).optional().describe('Filter by slot names (slots only)'),
      project_id: z.string().optional().describe('Filter by project (slots/frontier/edge_suggestions only)'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project (slots/frontier/edge_suggestions only)'),
      k: z.number().int().min(1).max(50).optional().describe('Max results (default 10, 1-50; frontier only)'),
      severity: z.enum(['critical', 'warning', 'info']).optional().describe('Minimum severity (health only)'),
      fix: z.boolean().optional().describe('Auto-fix safe issues (health only)'),
      dry_run: z.boolean().optional().describe('Preview without deleting (cleanup only). Defaults to true; set false to actually delete.')
    },
    handlers
  })
}
