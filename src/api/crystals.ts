import { Hono } from 'hono'
import { insertTelemetry, telemetryContext } from '../logging'
import { type CrystallizeInput, crystallize } from '../services/crystals.service'
import { ValidationError } from '../services/errors'
import { jsonBodyOrDefault } from './utils'

const crystalsRouter = new Hono()

crystalsRouter.post('/', async c => {
  const t0 = performance.now()
  const body = await jsonBodyOrDefault<CrystallizeInput | undefined>(c, undefined)
  try {
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
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400)
    throw err
  }
})

export { crystalsRouter }
