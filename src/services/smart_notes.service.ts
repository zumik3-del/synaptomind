import { getEdgesForThought } from '../db/edges'
import { getDb } from '../db'
import {
  createSmartNote as dbCreateSmartNote,
  deleteSmartNote as dbDeleteSmartNote,
  getSmartNote as dbGetSmartNote,
  listSmartNotes,
  type SmartNote,
  type SurfaceCondition,
  setSurfaceCheckedAt
} from '../db/smart_notes'
import { type Thought, updateThought } from '../db/thoughts'
import { getLogDb } from '../logging'
import { NotFoundError, ValidationError } from './errors'
import { getThoughtById } from './thoughts.service'
import { isOlderThanDays } from './utils'
import type { Database } from 'bun:sqlite'

export interface SmartNoteEval {
  note_id: string
  thought_id: string
  ready: boolean
  condition_hit: string | null
  surface_condition: SurfaceCondition
}

const VALID_TYPES = ['older_than_days', 'has_tag', 'has_edge_type', 'project_status', 'unread_for_days'] as const

// condition_hit marker for unread_for_days when the telemetry store (logs.db)
// cannot be opened (LOG_DB_PATH unset). ready stays false — the state must be
// distinguishable from a genuine "not yet ready" evaluation.
const TELEMETRY_UNAVAILABLE = 'telemetry_unavailable'

export function validateCondition(condition: unknown): SurfaceCondition {
  if (!condition || typeof condition !== 'object') {
    throw new ValidationError('surface_condition must be an object')
  }
  const c = condition as Record<string, unknown>
  const type = c.type as string
  if (!(VALID_TYPES as readonly string[]).includes(type)) {
    throw new ValidationError(`Invalid condition type '${type}'. Must be one of: ${VALID_TYPES.join(', ')}`)
  }
  if (
    (type === 'older_than_days' || type === 'project_status' || type === 'unread_for_days') &&
    !isPositiveInt(c.days)
  ) {
    throw new ValidationError(`Condition '${type}' requires a positive integer 'days'`)
  }
  if (type === 'has_tag' && (typeof c.tag !== 'string' || c.tag.length === 0)) {
    throw new ValidationError(`Condition 'has_tag' requires a non-empty 'tag'`)
  }
  if (type === 'has_edge_type' && (typeof c.edge_type !== 'string' || c.edge_type.length === 0)) {
    throw new ValidationError(`Condition 'has_edge_type' requires a non-empty 'edge_type'`)
  }
  return {
    type: type as SurfaceCondition['type'],
    days: typeof c.days === 'number' ? c.days : undefined,
    tag: typeof c.tag === 'string' ? c.tag : undefined,
    edge_type: typeof c.edge_type === 'string' ? c.edge_type : undefined
  }
}

function isPositiveInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

function hasEdgeType(thoughtId: string, edgeType: string, db: Database): boolean {
  return getEdgesForThought(db, thoughtId).some(e => e.type === edgeType)
}

// A project counts as "updated" if any of its thoughts was updated within the
// last `days` days. Derived from MAX(thoughts.updated_at) rather than a
// projects.updated_at column (which does not exist) — semantics: "the project
// saw edits recently".
function projectUpdatedWithinDays(thought: Thought, days: number, db: Database): boolean {
  const row = db
    .prepare(`SELECT MAX(updated_at) AS last_updated FROM thoughts WHERE project_id = ? AND status != 'archived'`)
    .get(thought.project_id) as { last_updated: string | null }
  if (!row?.last_updated) return false
  const ageMs = Date.now() - new Date(row.last_updated).getTime()
  return ageMs <= days * 86400000
}

export function evalCondition(thought: Thought, condition: SurfaceCondition): { ready: boolean; hit: string | null } {
  const d = getDb()
  switch (condition.type) {
    case 'older_than_days': {
      const days = condition.days ?? 0
      const ready = isOlderThanDays(thought.created_at, days)
      return { ready, hit: ready ? `older_than_days:${days}` : null }
    }
    case 'has_tag': {
      const tag = condition.tag ?? ''
      const ready = thought.tags.some(t => t.name.toLowerCase() === tag.toLowerCase())
      return { ready, hit: ready ? `has_tag:${tag}` : null }
    }
    case 'has_edge_type': {
      const edgeType = condition.edge_type ?? ''
      const ready = hasEdgeType(thought.id, edgeType, d)
      return { ready, hit: ready ? `has_edge_type:${edgeType}` : null }
    }
    case 'project_status': {
      const days = condition.days ?? 0
      const ready = projectUpdatedWithinDays(thought, days, d)
      return { ready, hit: ready ? `project_status:${days}` : null }
    }
    case 'unread_for_days': {
      // Ready when the thought was neither touched by telemetry events nor
      // edited for N days. ANY event on the thought (read/write/link/explore)
      // counts as interaction — per decision on issue #209.
      const days = condition.days ?? 0
      const logDb = getLogDb()
      if (!logDb) return { ready: false, hit: TELEMETRY_UNAVAILABLE }
      // Retention caveat: telemetry rows rotate (telemetry_max_rows), so very
      // long windows may look "unread" again after cleanup.
      const since = new Date(Date.now() - days * 86400000).toISOString()
      const row = logDb
        .prepare(`SELECT COUNT(*) AS cnt FROM thought_telemetry WHERE thought_id = ? AND created_at >= ?`)
        .get(thought.id, since) as { cnt: number }
      const stale = isOlderThanDays(thought.updated_at, days)
      const ready = stale && row.cnt === 0
      return { ready, hit: ready ? `unread_for_days:${days}` : null }
    }
    default:
      return { ready: false, hit: null }
  }
}

export function listSmartNotesWithReady(): Array<SmartNote & { ready: boolean; condition_hit: string | null }> {
  const d = getDb()
  const notes = listSmartNotes(d)
  return notes.map(note => {
    const thought = getThoughtById(note.thought_id)
    if (!thought) {
      return { ...note, ready: false, condition_hit: null }
    }
    const { ready, hit } = evalCondition(thought, note.surface_condition)
    return { ...note, ready, condition_hit: hit }
  })
}

export function evalAllSmartNotes(): SmartNoteEval[] {
  const notesWithReady = listSmartNotesWithReady()
  return notesWithReady.map(n => ({
    note_id: n.id,
    thought_id: n.thought_id,
    ready: n.ready,
    condition_hit: n.condition_hit,
    surface_condition: n.surface_condition
  }))
}

export interface AwakenedNote {
  note_id: string
  thought_id: string
  condition_hit: string | null
}

// Evaluates every smart note and promotes the ready ones to active, returning
// the list of thoughts that were woken. Non-ready notes are left untouched.
export function awakenReady(): AwakenedNote[] {
  const d = getDb()
  const notes = listSmartNotes(d)
  const awakened: AwakenedNote[] = []
  for (const note of notes) {
    const thought = getThoughtById(note.thought_id)
    if (!thought) continue
    const { ready, hit } = evalCondition(thought, note.surface_condition)
    if (!ready) continue
    promoteSmartNote(note.id)
    awakened.push({ note_id: note.id, thought_id: note.thought_id, condition_hit: hit })
  }
  return awakened
}

export function promoteSmartNote(id: string): Thought {
  const d = getDb()
  const note = dbGetSmartNote(d, id)
  if (!note) throw new NotFoundError('Smart note not found')
  const thought = getThoughtById(note.thought_id)
  if (!thought) throw new NotFoundError('Linked thought not found')
  setSurfaceCheckedAt(d, id)
  const updated = updateThought(d, note.thought_id, { status: 'active' })
  if (!updated) throw new NotFoundError('Linked thought not found')
  // Consume the note so it doesn't stay 'ready' forever and keep resurfacing
  // in the frontier on every subsequent eval (the condition stays satisfied).
  dbDeleteSmartNote(d, id)
  return updated
}

export function deleteSmartNote(id: string): void {
  const d = getDb()
  if (!dbDeleteSmartNote(d, id)) throw new NotFoundError('Smart note not found')
}

export function createSmartNoteService(thoughtId: string, condition: SurfaceCondition): SmartNote {
  return dbCreateSmartNote(getDb(), thoughtId, condition)
}
