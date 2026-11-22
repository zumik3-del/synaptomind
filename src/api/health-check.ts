import { Hono } from 'hono'
import { z } from 'zod/v4'
import {
  runHealthCheckView,
  severitySchema,
  type HealthViewOptions
} from '../services/health-check.service'
import { runHealthRepairService } from '../services/health-check-repair.service'
import { ValidationError } from '../errors'
import { formatZodIssues } from '../zod-utils'
import { jsonBodyOrDefault } from './utils'

const healthCheckRouter = new Hono()

const repairBodySchema = z.object({
  confirm: z.boolean().optional(),
  preview_token: z.string().optional(),
  severity: severitySchema.optional()
})

healthCheckRouter.get('/health-check', c => {
  const parsed = severitySchema.optional().safeParse(c.req.query('severity'))
  if (!parsed.success) throw new ValidationError(formatZodIssues(parsed.error))
  const options: HealthViewOptions = { severity: parsed.data, details: true }
  return c.json(runHealthCheckView(options))
})

healthCheckRouter.post('/health-check/repair', async c => {
  const data = await jsonBodyOrDefault(c, {}, repairBodySchema)
  const result = runHealthRepairService({
    confirm: data.confirm,
    preview_token: data.preview_token,
    severity: data.severity
  })
  return c.json(result)
})

export { healthCheckRouter }
