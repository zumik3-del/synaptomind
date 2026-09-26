import { Hono } from 'hono'
import { NotFoundError } from '../errors'
import { withTelemetry } from '../logging'
import { listPrimersService, deletePrimerService } from '../services/primers.service'

const primersRouter = new Hono()

primersRouter.get('/', c => {
  return withTelemetry(c, { action: 'read', toolName: 'list_primers' }, c2 => {
    return c2.json(listPrimersService())
  })
})

primersRouter.delete('/:id', c => {
  return withTelemetry(c, { action: 'write', toolName: 'delete_primer' }, c2 => {
    const deleted = deletePrimerService(c2.req.param('id')!)
    if (!deleted) throw new NotFoundError()
    return c2.json({ success: true })
  })
})

export { primersRouter }
