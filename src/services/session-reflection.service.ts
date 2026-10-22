import { config } from '../config'
import { getDb } from '../db'
import { projectExists } from '../db/projects'
import { findActiveDecisionThoughts } from '../db/session-reflection'
import { getSlotRow, upsertSlot } from '../db/slots'
import { createThought } from '../db/thoughts'
import { NotFoundError, ValidationError } from '../errors'
import { jaccard, normalise } from './text-similarity'
import type { Database } from 'bun:sqlite'

export interface ReflectInput {
  project_id?: string | null
  summary?: string
  goals_add?: string[]
  goals_remove?: string[]
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

/**
 * Stamped on every thought `reflect` creates, next to the semantic tag
 * (`decision` / `pending`). It makes reflect output identifiable, so it can be
 * filtered or cleaned up without touching hand-created thoughts. Tag-based,
 * additive: nothing in the read paths keys off it.
 */
export const REFLECT_TAG = 'reflect'

function reflectTimestamp(): string {
  return new Date().toISOString()
}

function tail(content: string, maxChars: number): string {
  return content.length > maxChars ? content.slice(-maxChars) : content
}

function assertProjectExists(projectId: string, db: Database): void {
  if (!projectExists(db, projectId)) throw new NotFoundError('Project not found')
}

/**
 * Validates one goal input array and returns its trimmed entries. A blank or
 * non-string entry is a validation error rather than a silent skip: the caller
 * would otherwise believe the goal was applied.
 */
function parseGoalEntries(
  entries: readonly unknown[] | undefined,
  field: 'goals_add' | 'goals_remove'
): string[] {
  if (!entries) return []
  return entries.map(entry => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new ValidationError(`${field} entries must be non-empty strings`)
    }
    return entry.trim()
  })
}

/**
 * Returns true if `decision` is sufficiently similar to any existing
 * non-archived decision-tagged thought (Jaccard >= 0.6 or exact normalised match).
 */
function hasDuplicateDecision(db: Database, decision: string): boolean {
  const candidates = findActiveDecisionThoughts(db)
  const norm = normalise(decision)
  for (const c of candidates) {
    if (normalise(c.content) === norm) return true
    if (jaccard(norm, normalise(c.content)) >= 0.6) return true
  }
  return false
}

export function reflectSessionService(input: ReflectInput, d: Database = getDb()): ReflectResult {
  const goalsToAdd = parseGoalEntries(input.goals_add, 'goals_add')
  const goalsToRemove = parseGoalEntries(input.goals_remove, 'goals_remove')

  const hasAny =
    input.summary !== undefined ||
    goalsToAdd.length > 0 ||
    goalsToRemove.length > 0 ||
    (input.decisions?.length ?? 0) > 0 ||
    (input.pending?.length ?? 0) > 0
  if (!hasAny) {
    throw new ValidationError(
      'nothing to reflect: provide summary, goals_add, goals_remove, decisions or pending'
    )
  }

  const result: ReflectResult = {
    summary_appended: false,
    goals_added: 0,
    goals_removed: 0,
    decisions_created: 0,
    pending_created: 0
  }

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

    if (goalsToAdd.length > 0 || goalsToRemove.length > 0) {
      const row = getSlotRow(d, 'active_goals', scope, scopeId)
      const maxChars = row?.max_chars ?? config.slots.defaultMaxChars
      const lines = (row?.content ?? '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)

      // Removals run before additions: a removal target is matched against the
      // goals that were already stored, so a goal added in the same call is
      // never dropped by a stale removal entry.
      for (const target of goalsToRemove) {
        const lower = target.toLowerCase()
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i].toLowerCase().includes(lower)) {
            lines.splice(i, 1)
            result.goals_removed++
          }
        }
      }

      for (const goal of goalsToAdd) {
        if (!lines.some(l => l.toLowerCase() === goal.toLowerCase())) {
          lines.push(goal)
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
        tags: ['decision', REFLECT_TAG],
        ...(input.project_id ? { project_id: input.project_id } : {})
      })
      result.decisions_created++
    }

    const wakeDays = input.wake_days ?? 7
    if (!Number.isInteger(wakeDays) || wakeDays < 1 || wakeDays > 365) {
      throw new ValidationError('wake_days must be an integer between 1 and 365')
    }
    // Delay is per-reflection and set only on newly created pending thoughts;
    // the content-hash dedup branch leaves an existing schedule untouched.
    const surfaceAfter = new Date(Date.now() + wakeDays * 86_400_000).toISOString()
    for (const item of input.pending ?? []) {
      if (typeof item !== 'string' || !item.trim()) {
        throw new ValidationError('pending entries must be non-empty strings')
      }
      createThought(d, {
        content: item.trim(),
        status: 'draft',
        source: 'session-reflection',
        tags: ['pending', REFLECT_TAG],
        surface_after: surfaceAfter,
        ...(input.project_id ? { project_id: input.project_id } : {})
      })
      result.pending_created++
    }
  })
  run()

  return result
}
