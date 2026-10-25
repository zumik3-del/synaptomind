import { Hono } from 'hono'
import { z } from 'zod/v4'
import { runHealthCheckService } from '../services/health-check.service'
import { runHealthRepairService } from '../services/health-check-repair.service'
import { jsonBodyOrDefault } from './utils'
import type { Severity } from '../services/health-check.service'

const healthCheckRouter = new Hono()

const repairBodySchema = z.object({
  confirm: z.boolean().optional(),
  preview_token: z.string().optional(),
  severity: z.enum(['critical', 'warning', 'info']).optional()
})

healthCheckRouter.get('/health-check', c => {
  const severity = c.req.query('severity') as Severity | undefined
  const report = runHealthCheckService({ severity })
  return c.json(report)
})

healthCheckRouter.post('/health-check/repair', async c => {
  const data = await jsonBodyOrDefault(c, {}, repairBodySchema) as { confirm?: boolean; preview_token?: string; severity?: Severity }
  const result = runHealthRepairService({
    confirm: data.confirm,
    preview_token: data.preview_token,
    severity: data.severity
  })
  return c.json(result)
})

export { healthCheckRouter }
