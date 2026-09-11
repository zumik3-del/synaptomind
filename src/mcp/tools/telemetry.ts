import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Database } from 'bun:sqlite'
import { getLogDb } from '../../logging'
import { runSelfImproveJob } from '../../services/self-improve.service'
import {
  queryPatterns,
  queryFrequency,
  queryOrphanWritesAggregate,
  queryDraftLifecycle
} from '../../services/telemetry-queries'
import { listPrimersService, deletePrimerService } from '../../services/primers.service'
import { jsonResult, errorResult, toolOutputShape } from './utils'

type MetricHandler = (since: string, limit: number) => unknown

function buildMetricHandlers(logDb: Database) {
  return {
    patterns: (since: string, limit: number) => queryPatterns(logDb, since, limit),
    frequency: (since: string, limit: number) => queryFrequency(logDb, since, limit),
    orphan_writes: (since: string) => queryOrphanWritesAggregate(logDb, since),
    draft_lifecycle: (since: string) => queryDraftLifecycle(logDb, since)
  }
}

export function registerMemoryTelemetry(server: McpServer) {
  server.registerTool('memory_telemetry', {
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
    outputSchema: toolOutputShape
  }, async (args) => {
    try {
      if (args.action === 'query') {
        const logDb = getLogDb()
        if (!logDb) return errorResult('Log database not available')
        const windowSec = args.window ?? 86400
        const since = new Date(Date.now() - windowSec * 1000).toISOString()
        const limit = args.limit ?? 10
        if (!args.metric) return errorResult('metric is required for query action')
        const handlers = buildMetricHandlers(logDb)
        const handler = (handlers as Record<string, MetricHandler>)[args.metric]
        if (!handler) return errorResult('Invalid metric')
        const rows = handler(since, limit)
        return jsonResult(rows)
      }

      if (args.action === 'analyze') {
        const result = await runSelfImproveJob({ dryRun: args.dry_run })
        return jsonResult(result)
      }

      if (args.action === 'primers') {
        const primerAction = args.primer_action ?? 'list'
        if (primerAction === 'list') {
          const primers = listPrimersService()
          return jsonResult(primers)
        }
        if (primerAction === 'delete') {
          if (!args.primer_id) return errorResult('primer_id required for delete')
          const deleted = deletePrimerService(args.primer_id)
          return jsonResult({ deleted })
        }
        return errorResult('Invalid primer action')
      }

      return errorResult(`Unknown action: ${args.action}`)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'memory_telemetry failed')
    }
  })
}
