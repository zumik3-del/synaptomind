import { Hono } from 'hono'
import { z } from 'zod/v4'
import { config } from '../config'
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
  goals_add: z.array(z.string()).optional(),
  goals_remove: z.array(z.string()).optional(),
  decisions: z.array(z.string()).optional(),
  pending: z.array(z.string()).optional(),
  wake_days: z.number().int().min(1).max(365).optional(),
  // Tombstone for the retired goals argument: a supplied value becomes a 400
  // naming the canonical replacements instead of a silent drop.
  goals_delta: z.never({ error: 'goals_delta was removed; use goals_add / goals_remove' }).optional()
})

const slotsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional().default(0)
})

slotsRouter.get('/', c => {
  const projectId = c.req.query('project_id') || undefined
  const names = (c.req.query('names') || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const parsed = slotsQuerySchema.safeParse({
    limit: c.req.query('limit') || undefined,
    offset: c.req.query('offset') || undefined
  })
  if (!parsed.success) throw new ValidationError(formatZodIssues(parsed.error))
  return c.json({ slots: getSlots({ projectId, names, limit: parsed.data.limit, offset: parsed.data.offset }) })
})

slotsRouter.put('/:name', async c => {
  const name = c.req.param('name')!
  const body = await jsonBodyOrDefault(c, {}, updateSlotBodySchema)
  const slot = updateExplicitSlot(name, { ...body, content: body.content ?? '' }, config.slots.defaultMaxChars)
  return c.json(slot)
})

slotsRouter.post('/reflect', async c => {
  const body = await jsonBodyOrDefault<ReflectInput | undefined>(c, undefined, reflectBodySchema as z.ZodType<ReflectInput | undefined>)
  const result = reflectSessionService(body ?? ({} as ReflectInput))
  return c.json({ ok: true, applied: result })
})

export { slotsRouter }
