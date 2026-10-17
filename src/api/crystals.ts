import { Hono } from 'hono'
import { withTelemetry } from '../logging'
import { type CrystallizeInput, crystallizeService } from '../services/crystals.service'
import { jsonBodyOrDefault } from './utils'

const crystalsRouter = new Hono()

crystalsRouter.post('/', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'crystallizeService' }, async c2 => {
    const body = await jsonBodyOrDefault<CrystallizeInput | undefined>(c2, undefined)
    const result = crystallizeService(body ?? ({} as CrystallizeInput))
    return c2.json(result)
  })
})

export { crystalsRouter }
