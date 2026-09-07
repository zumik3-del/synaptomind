import { config } from '../config'
import { getDb } from '../db'
import { getSlotRow, upsertSlot } from '../db/slots'
import { createSmartNote } from '../db/smart_notes'
import { createThought } from '../db/thoughts'
import { NotFoundError, ValidationError } from '../errors'

export interface ReflectInput {
  project_id?: string | null
  summary?: string
  goals_delta?: string[]
  decisions?: string[]
  pending?: string[]
  wake_days?: number
}

export interface ReflectResult {
  summary_appended: boolean
  goals_added: number
  goals_removed: number
  decisions_created: number
  pending_created: number
}

const CLOSED_PREFIXES = ['closed:']

function reflectTimestamp(): string {
  return new Date().toISOString()
}

function tail(content: string, maxChars: number): string {
  return content.length > maxChars ? content.slice(-maxChars) : content
}

function assertProjectExists(projectId: string, db: ReturnType<typeof getDb>): void {
  const project = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(projectId)
  if (!project) throw new NotFoundError('Project not found')
}

/** Normalise a string for fuzzy comparison: lowercase, collapse whitespace. */
function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Word-set Jaccard similarity on normalised text. */
function jaccard(a: string, b: string): number {
  const setA = new Set(a.split(/\s+/).filter(Boolean))
  const setB = new Set(b.split(/\s+/).filter(Boolean))
  if (setA.size === 0 && setB.size === 0) return 1
  if (setA.size === 0 || setB.size === 0) return 0
  let overlap = 0
  for (const w of setA) if (setB.has(w)) overlap++
  return overlap / (setA.size + setB.size - overlap)
}

/**
 * Returns true if `decision` is sufficiently similar to any existing
 * non-archived decision-tagged thought (Jaccard >= 0.6 or exact normalised match).
 */
function hasDuplicateDecision(db: ReturnType<typeof getDb>, decision: string): boolean {
  const candidates = db.prepare(`
    SELECT t.id, t.content FROM thoughts t
    JOIN thought_tags tt ON tt.thought_id = t.id
    JOIN tags tg ON tg.id = tt.tag_id
    WHERE tg.name = 'decision' AND t.status != 'archived'
  `).all() as { id: string; content: string }[]
  const norm = normalise(decision)
  for (const c of candidates) {
    if (normalise(c.content) === norm) return true
    if (jaccard(norm, normalise(c.content)) >= 0.6) return true
  }
  return false
}

export function reflectSession(input: ReflectInput): ReflectResult {
  const hasAny =
    input.summary !== undefined ||
    (input.goals_delta?.length ?? 0) > 0 ||
    (input.decisions?.length ?? 0) > 0 ||
    (input.pending?.length ?? 0) > 0
  if (!hasAny) {
    throw new ValidationError('nothing to reflect: provide summary, goals_delta, decisions or pending')
  }

  const result: ReflectResult = {
    summary_appended: false,
    goals_added: 0,
    goals_removed: 0,
    decisions_created: 0,
    pending_created: 0
  }

  const d = getDb()
  const scope = input.project_id ? ('project' as const) : ('global' as const)
  const scopeId = input.project_id ?? null
  if (scope === 'project') assertProjectExists(scopeId as string, d)

  const run = d.transaction(() => {
    if (input.summary !== undefined) {
      if (typeof input.summary !== 'string' || !input.summary.trim()) {
        throw new ValidationError('summary must be a non-empty string')
      }
      const existing = getSlotRow(d, 'project_context', scope, scopeId)
      const maxChars = existing?.max_chars ?? config.slots.defaultMaxChars
      const base = existing?.content ? `${existing.content.replace(/\s+$/, '')}\n` : ''
      upsertSlot(d, {
        name: 'project_context',
        scope,
        scope_id: scopeId,
        content: tail(`${base}[${reflectTimestamp()}] ${input.summary.trim()}`, maxChars),
        max_chars: maxChars
      })
      result.summary_appended = true
    }

    if ((input.goals_delta?.length ?? 0) > 0) {
      for (const delta of input.goals_delta as unknown[]) {
        if (typeof delta !== 'string' || !delta.trim()) {
          throw new ValidationError('goals_delta entries must be non-empty strings')
        }
      }
      const row = getSlotRow(d, 'active_goals', scope, scopeId)
      const maxChars = row?.max_chars ?? config.slots.defaultMaxChars
      const lines = (row?.content ?? '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
      for (const raw of input.goals_delta as string[]) {
        const lower = raw.trim().toLowerCase()
        const prefix = CLOSED_PREFIXES.find(p => lower.startsWith(p))
        if (prefix) {
          const target = raw.trim().slice(prefix.length).trim().toLowerCase()
          if (!target) continue
          for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].toLowerCase().includes(target)) {
              lines.splice(i, 1)
              result.goals_removed++
            }
          }
        } else if (!lines.some(l => l.toLowerCase() === lower)) {
          lines.push(raw.trim())
          result.goals_added++
        }
      }
      upsertSlot(d, {
        name: 'active_goals',
        scope,
        scope_id: scopeId,
        content: tail(lines.join('\n'), maxChars),
        max_chars: maxChars
      })
    }

    // Create a thought for each decision, skipping those that are sufficiently
    // similar to an existing non-archived decision (dedup across sessions).
    for (const decision of input.decisions ?? []) {
      if (typeof decision !== 'string' || !decision.trim()) {
        throw new ValidationError('decisions entries must be non-empty strings')
      }
      if (hasDuplicateDecision(d, decision)) continue
      createThought(d, {
        content: decision.trim(),
        status: 'active',
        source: 'session-reflection',
        tags: ['decision'],
        ...(input.project_id ? { project_id: input.project_id } : {})
      })
      result.decisions_created++
    }

    const wakeDays = input.wake_days ?? 7
    if (!Number.isInteger(wakeDays) || wakeDays < 1 || wakeDays > 365) {
      throw new ValidationError('wake_days must be an integer between 1 and 365')
    }
    for (const item of input.pending ?? []) {
      if (typeof item !== 'string' || !item.trim()) {
        throw new ValidationError('pending entries must be non-empty strings')
      }
      const thought = createThought(d, {
        content: item.trim(),
        status: 'draft',
        source: 'session-reflection',
        tags: ['pending'],
        ...(input.project_id ? { project_id: input.project_id } : {})
      })
      createSmartNote(d, thought.id, { type: 'older_than_days', days: wakeDays })
      result.pending_created++
    }
  })
  run()

  return result
}
