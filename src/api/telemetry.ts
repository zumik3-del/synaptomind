import { Hono } from 'hono'
import type { Context } from 'hono'
import { queryTelemetryReport, type TelemetryMetric } from '../services/telemetry.service'

// Intentionally NOT wrapped in withTelemetry: these endpoints read the
// telemetry log itself, so instrumenting them would be self-referential noise.
const telemetryRouter = new Hono()

/** Parse an optional integer query param; absent/non-numeric -> undefined (service default). */
function optionalInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? undefined : parsed
}

// Thin routes: parse the query params, delegate aggregation to the telemetry
// service, then serialize the returned DTO (thin-route rule, §4).
function report(metric: TelemetryMetric) {
  return (c: Context) => {
    const result = queryTelemetryReport(
      metric,
      optionalInt(c.req.query('window')),
      optionalInt(c.req.query('limit'))
    )
    if (!result.ok) return c.json({ error: result.error }, 503)
    return c.json(result.data)
  }
}

telemetryRouter.get('/patterns', report('patterns'))
telemetryRouter.get('/frequency', report('frequency'))
telemetryRouter.get('/orphan_writes', report('orphan_writes'))
telemetryRouter.get('/draft_lifecycle', report('draft_lifecycle'))

export { telemetryRouter }
