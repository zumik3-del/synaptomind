import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getLogDb } from '../../logging'
import { runSelfImproveJob } from '../../services/self-improve.service'
import {
  queryPatterns,
  queryFrequency,
  queryOrphanWritesAggregate,
  queryDraftLifecycle
} from '../../services/telemetry-queries'
import { jsonResult, errorResult } from './utils'

type MetricHandler = (since: string, limit: number) => unknown

function buildMetricHandlers(logDb: { prepare: (sql: string) => unknown }) {
  return {
    patterns: (since: string, limit: number) => queryPatterns(logDb as any, since, limit),
    frequency: (since: string, limit: number) => queryFrequency(logDb as any, since, limit),
    orphan_writes: (since: string) => queryOrphanWritesAggregate(logDb as any, since),
    draft_lifecycle: (since: string) => queryDraftLifecycle(logDb as any, since)
  }
}

export function registerTelemetryTools(server: McpServer) {
  server.tool('get_telemetry', 'Query telemetry aggregates', {
    metric: z.enum(['patterns', 'frequency', 'orphan_writes', 'draft_lifecycle']).describe('Metric to query: patterns, frequency, orphan_writes, draft_lifecycle'),
    window: z.number().optional().describe('Time window in seconds (default 86400)'),
    limit: z.number().optional().describe('Max results (default 10)')
  }, async (args) => {
    const logDb = getLogDb()
    if (!logDb) return errorResult('Log database not available')
    const windowSec = args.window ?? 86400
    const since = new Date(Date.now() - windowSec * 1000).toISOString()
    const limit = args.limit ?? 10

    const handlers = buildMetricHandlers(logDb)
    const handler = (handlers as Record<string, MetricHandler>)[args.metric]
    if (!handler) return errorResult('Invalid metric')
    const rows = handler(since, limit)
    return jsonResult(rows)
  })

  server.tool('analyze_telemetry', 'Analyze thought patterns: orphans, merges, promotions', {
    window: z.number().optional().describe('Time window in seconds (default 86400)'),
    dry_run: z.boolean().optional().describe('Dry run mode')
  }, async (args) => {
    const result = await runSelfImproveJob({ dryRun: args.dry_run })
    return jsonResult(result)
  })
}
