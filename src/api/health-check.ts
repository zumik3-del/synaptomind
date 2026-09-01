import { Hono } from 'hono'
import { withTelemetry } from '../logging'
import { runHealthCheck } from '../services/health-check.service'
import type { Severity } from '../services/health-check.service'

export const healthCheckRouter = new Hono()

healthCheckRouter.get('/health-check', c => {
  return withTelemetry(c, { action: 'read', toolName: 'health_check' }, c2 => {
    const severity = c2.req.query('severity') as Severity | undefined
    const fix = c2.req.query('fix') === 'true'
    const report = runHealthCheck({ severity, fix })
    return c2.json(report)
  })
})
