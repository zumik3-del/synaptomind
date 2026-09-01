import { Hono } from 'hono'
import { listPrimersService, deletePrimerService } from '../services/primers.service'

const primersRouter = new Hono()

primersRouter.get('/', c => {
  return c.json(listPrimersService())
})

primersRouter.delete('/:id', c => {
  const deleted = deletePrimerService(c.req.param('id'))
  if (!deleted) return c.json({ error: 'Not found' }, 404)
  return c.json({ success: true })
})

export { primersRouter }
