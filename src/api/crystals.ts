import { Hono } from 'hono'
import { insertTelemetry, telemetryContext } from '../logging'
import { type CrystallizeInput, crystallize } from '../services/crystals.service'
import { jsonBodyOrDefault } from './utils'

const crystalsRouter = new Hono()

crystalsRouter.post('/', async c => {
  const t0 = performance.now()
  const body = await jsonBodyOrDefault<CrystallizeInput | undefined>(c, undefined)
  const result = crystallize(body ?? ({} as CrystallizeInput))
  const ctx = telemetryContext(c)
  if (ctx)
    void insertTelemetry({
      action: 'write',
      toolName: 'crystallize',
      latencyMs: performance.now() - t0,
      ...ctx
    })
  return c.json(result)
})

export { crystalsRouter }
