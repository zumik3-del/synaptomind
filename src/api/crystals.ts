import { Hono } from 'hono'
import { z } from 'zod/v4'
import { withTelemetry } from '../logging'
import { type CrystallizeInput, crystallizeService } from '../services/crystals.service'
import { jsonBodyOrDefault } from './utils'

const crystalsRouter = new Hono()
const crystallizeBodySchema = z.object({
  thought_ids: z.array(z.string()).optional(),
  cluster_id: z.string().optional(),
  style: z.enum(['runbook', 'decision-log', 'overview']).optional(),
  project_id: z.string().optional()
})

crystalsRouter.post('/', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'crystallize' }, async c2 => {
    const body = await jsonBodyOrDefault<CrystallizeInput | undefined>(c2, undefined, crystallizeBodySchema.optional())
    const result = crystallizeService(body ?? ({} as CrystallizeInput))
    return c2.json(result)
  })
})

export { crystalsRouter }
