import { Hono } from 'hono'
import { z } from 'zod/v4'
import { config } from '../config'
import { withTelemetry } from '../logging'
import { ValidationError } from '../errors'
import { getSlots, type ReflectInput, reflectSessionService, updateExplicitSlot } from '../services/slots.service'
import { formatZodIssues, jsonBodyOrDefault } from './utils'

const slotsRouter = new Hono()

// Shared body helper (audit M8): a malformed payload becomes a typed 400, while
// an absent body keeps the `{}` default (the slot update already tolerates it).
const updateSlotBodySchema = z.object({
  content: z.string().optional(),
  max_chars: z.number().int().optional(),
  scope: z.enum(['project', 'global']).optional(),
  project_id: z.string().optional()
})

// Shared body schema for the reflect endpoint (audit M8 residual): a malformed
// payload (e.g. `decisions` given as a string instead of string[]) becomes a
// typed 400 instead of being iterated character-by-character downstream.
export const reflectBodySchema = z.object({
  project_id: z.string().nullable().optional(),
  summary: z.string().optional(),
  goals_delta: z.array(z.string()).optional(),
  decisions: z.array(z.string()).optional(),
  pending: z.array(z.string()).optional(),
  wake_days: z.number().int().min(1).max(365).optional()
})

const slotsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional().default(0)
})

slotsRouter.get('/', c => {
  return withTelemetry(c, { action: 'read', toolName: 'get_slots' }, c2 => {
    const projectId = c2.req.query('project_id') || undefined
    const names = (c2.req.query('names') || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    const parsed = slotsQuerySchema.safeParse({
      limit: c2.req.query('limit') || undefined,
      offset: c2.req.query('offset') || undefined
    })
    if (!parsed.success) throw new ValidationError(formatZodIssues(parsed.error))
    return c2.json({ slots: getSlots({ projectId, names, limit: parsed.data.limit, offset: parsed.data.offset }) })
  })
})

slotsRouter.put('/:name', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'update_slot' }, async c2 => {
    const name = c2.req.param('name')!
    const body = await jsonBodyOrDefault(c2, {}, updateSlotBodySchema)
    const slot = updateExplicitSlot(name, { ...body, content: body.content ?? '' }, config.slots.defaultMaxChars)
    return c2.json(slot)
  })
})

slotsRouter.post('/reflect', async c => {
  return withTelemetry(c, { action: 'write', toolName: 'reflect_session' }, async c2 => {
    const body = await jsonBodyOrDefault<ReflectInput | undefined>(c2, undefined, reflectBodySchema as z.ZodType<ReflectInput | undefined>)
    const result = reflectSessionService(body ?? ({} as ReflectInput))
    return c2.json({ ok: true, applied: result })
  })
})

export { slotsRouter }
