import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { runHealthCheck } from '../../services/health-check.service'
import { jsonResult, errorResult } from './utils'

export function registerHealthCheckTools(server: McpServer) {
  server.tool('health_check', 'Audit graph health: broken links, orphans, duplicates, structural issues', {
    severity: z.enum(['critical', 'warning', 'info']).optional().describe('Minimum severity to report: critical, warning, info (default: all)'),
    fix: z.boolean().optional().describe('Auto-fix safe issues (orphan edges, empty clusters, test remnants)')
  }, async (args) => {
    try {
      const report = runHealthCheck({
        severity: args.severity,
        fix: args.fix
      })
      return jsonResult(report)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'Health check failed')
    }
  })
}
