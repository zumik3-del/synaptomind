import { Hono } from 'hono'
import { config } from '../config'
import { withTelemetry } from '../logging'
import { getSlots, type ReflectInput, reflectSession, updateExplicitSlot } from '../services/slots.service'
import { jsonBodyOrDefault } from './utils'

const slotsRouter = new Hono()

slotsRouter.get('/', c => {
  const projectId = c.req.query('project_id') || undefined
  const names = (c.req.query('names') || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  return c.json({ slots: getSlots({ projectId, names }) })
})

slotsRouter.put('/:name', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'update_slot' }, async c2 => {
    const name = c2.req.param('name')!
    const body = await c2.req.json() as {
      content?: string
      max_chars?: number
      scope?: 'project' | 'global'
      project_id?: string
    }
    const slot = updateExplicitSlot(name, { ...body, content: body.content ?? '' }, config.slots.defaultMaxChars)
    return c2.json(slot)
  })
})

slotsRouter.post('/reflect', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'reflect_session' }, async c2 => {
    const body = await jsonBodyOrDefault<ReflectInput | undefined>(c2, undefined)
    const result = reflectSession(body ?? ({} as ReflectInput))
    return c2.json({ ok: true, applied: result })
  })
})

export { slotsRouter }
