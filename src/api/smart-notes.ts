import { Hono } from 'hono'
import type { SurfaceCondition } from '../db/smart_notes'
import { NotFoundError, ValidationError } from '../services/errors'
import {
  awakenReady,
  createSmartNoteService,
  deleteSmartNote,
  evalAllSmartNotes,
  listSmartNotesWithReady,
  promoteSmartNote,
  validateCondition
} from '../services/smart_notes.service'
import { getThoughtById } from '../services/thoughts.service'

const smartNotesRouter = new Hono()

smartNotesRouter.get('/', c => {
  return c.json(listSmartNotesWithReady())
})

smartNotesRouter.post('/', async c => {
  const body = await c.req.json<{ thought_id?: string; surface_condition?: unknown }>()
  if (!body.thought_id) {
    return c.json({ error: 'thought_id is required' }, 400)
  }
  const thought = getThoughtById(body.thought_id)
  if (!thought) {
    return c.json({ error: 'Thought not found' }, 404)
  }
  if (thought.is_cluster) {
    return c.json({ error: 'Smart notes are not supported for cluster thoughts' }, 400)
  }
  let condition: SurfaceCondition
  try {
    condition = validateCondition(body.surface_condition)
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400)
    }
    throw err
  }
  const note = createSmartNoteService(body.thought_id, condition)
  return c.json(note, 201)
})

smartNotesRouter.post('/eval', c => {
  return c.json(evalAllSmartNotes())
})

smartNotesRouter.post('/awaken', c => {
  const awakened = awakenReady()
  return c.json({ awakened, count: awakened.length })
})

smartNotesRouter.post('/:id/promote', c => {
  try {
    const thought = promoteSmartNote(c.req.param('id'))
    return c.json({ ok: true, thought })
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404)
    throw err
  }
})

smartNotesRouter.delete('/:id', c => {
  try {
    deleteSmartNote(c.req.param('id'))
    return c.json({ success: true })
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404)
    throw err
  }
})

export { smartNotesRouter }
