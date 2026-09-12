import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { runSelfImproveJob } from '../../services/self-improve.service'
import { queryTelemetryMetric, type TelemetryMetric } from '../../services/telemetry.service'
import { listPrimersService, deletePrimerService } from '../../services/primers.service'
import { registerActionTool, type ActionArgs } from './action-tool'

const METRICS = ['patterns', 'frequency', 'orphan_writes', 'draft_lifecycle'] as const

const handlers = {
  query: {
    input: z.object({ metric: z.enum(METRICS, { error: 'metric is required for query action' }) }),
    run(args: ActionArgs) {
      const windowSec = (args.window as number | undefined) ?? 86400
      const since = new Date(Date.now() - windowSec * 1000).toISOString()
      const limit = (args.limit as number | undefined) ?? 10
      const result = queryTelemetryMetric(args.metric as TelemetryMetric, since, limit)
      if (!result.ok) throw new Error(result.error)
      return result.data
    }
  },

  analyze: {
    async run(args: ActionArgs) {
      return runSelfImproveJob({ dryRun: args.dry_run as boolean | undefined })
    }
  },

  primers: {
    input: z
      .object({
        primer_action: z.enum(['list', 'delete']).optional(),
        primer_id: z.string().optional()
      })
      .refine(v => v.primer_action !== 'delete' || !!v.primer_id, {
        message: 'primer_id required for delete',
        path: ['primer_id']
      }),
    run(args: ActionArgs) {
      const primerAction = (args.primer_action as 'list' | 'delete' | undefined) ?? 'list'
      if (primerAction === 'delete') {
        return { deleted: deletePrimerService(args.primer_id as string) }
      }
      return listPrimersService()
    }
  }
}

export function registerMemoryTelemetry(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_telemetry',
    description: `Analytics and self-improvement. Actions:
- query: Query telemetry aggregates (patterns, frequency, orphan_writes, draft_lifecycle)
- analyze: Analyze thought patterns — orphans, merges, promotions (self-improve job)
- primers: List or delete primers`,
    inputSchema: {
      action: z.enum(['query', 'analyze', 'primers']).describe('Action'),
      metric: z.enum(['patterns', 'frequency', 'orphan_writes', 'draft_lifecycle']).optional().describe('Metric to query (query only)'),
      window: z.number().int().min(1).max(31_536_000).optional().describe('Time window in seconds (default 86400, 1-31536000)'),
      limit: z.number().int().min(1).max(1000).optional().describe('Max results (default 10, 1-1000; patterns/frequency only)'),
      dry_run: z.boolean().optional().describe('Dry run mode (analyze only)'),
      primer_action: z.enum(['list', 'delete']).optional().describe('Primer action (primers only)'),
      primer_id: z.string().optional().describe('Primer ID to delete (primers delete only)')
    },
    handlers
  })
}
