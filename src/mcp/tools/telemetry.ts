import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { runSelfImproveJob } from '../../services/self-improve.service'
import {
  queryTelemetryMetric,
  resolveTelemetryLimit,
  resolveTelemetryWindow,
  type TelemetryMetric
} from '../../services/telemetry.service'
import { listPrimersService, deletePrimerService } from '../../services/primers.service'
import { registerActionTool, type ActionArgs } from './action-tool'

const METRICS = ['patterns', 'frequency', 'orphan_writes', 'draft_lifecycle'] as const

const handlers = {
  query: {
    input: z.object({ metric: z.enum(METRICS, { error: 'metric is required for query action' }) }),
    run(args: ActionArgs) {
      const metric = args.metric as TelemetryMetric
      const window = resolveTelemetryWindow(metric, args.window as number | undefined)
      const limit = resolveTelemetryLimit(metric, args.limit as number | undefined)
      const result = queryTelemetryMetric(metric, window.since, limit)
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
      window: z.number().int().min(1).max(31_536_000).optional().describe('Time window in seconds (per-metric default and floor applied)'),
      limit: z.number().int().min(1).max(1000).optional().describe('Max results (per-metric default and cap applied; patterns/frequency only)'),
      dry_run: z.boolean().optional().describe('Dry run mode (analyze only)'),
      primer_action: z.enum(['list', 'delete']).optional().describe('Primer action (primers only)'),
      primer_id: z.string().optional().describe('Primer ID to delete (primers delete only)')
    },
    handlers
  })
}
