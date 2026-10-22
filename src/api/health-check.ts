import { Hono } from 'hono'
import { runHealthCheckService } from '../services/health-check.service'
import type { Severity } from '../services/health-check.service'

const healthCheckRouter = new Hono()

healthCheckRouter.get('/health-check', c => {
  const severity = c.req.query('severity') as Severity | undefined
  const fix = c.req.query('fix') === 'true'
  const report = runHealthCheckService({ severity, fix })
  return c.json(report)
})

export { healthCheckRouter }
