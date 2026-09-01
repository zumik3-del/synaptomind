import { config } from '../config'
import { getDb } from '../db'
import { getPrimers } from '../db/primers'
import { getSlotRow, upsertSlot } from '../db/slots'
import { NotFoundError, ValidationError } from './errors'
import { listSmartNotesWithReady } from './smart_notes.service'
import { getThoughtById } from './thoughts.service'
import type { Database } from 'bun:sqlite'

// Canonical slot order — consumers (MCP digest, future UI) rely on it.
export const SLOT_NAMES = [
  'persona',
  'pending_items',
  'architecture_decisions',
  'project_context',
  'active_goals'
] as const
export type SlotName = (typeof SLOT_NAMES)[number]

// Virtual slots are composed from existing mechanisms on every read and are
// never stored; explicit slots live in the `slots` table.
export const VIRTUAL_SLOT_NAMES = new Set<string>(['persona', 'pending_items', 'architecture_decisions'])
export const EXPLICIT_SLOT_NAMES = new Set<string>(['project_context', 'active_goals'])

export interface SlotView {
  name: SlotName
  scope: 'project' | 'global'
  virtual: boolean
  content: string
  truncated: boolean
  max_chars: number
  updated_at: string | null
}

function truncate(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (content.length <= maxChars) return { content, truncated: false }
  return { content: content.slice(0, maxChars), truncated: true }
}

// persona — auto-generated profile summaries (FI-08).
function personaContent(db: Database): string {
  const rows = db
    .prepare(
      `SELECT content FROM thoughts WHERE source = 'profile-summary' AND status != 'archived' ORDER BY created_at ASC`
    )
    .all() as { content: string }[]
  return rows.map(r => r.content).join('\n\n')
}

// pending_items — smart notes whose wake-up condition is currently met (FI-03).
function pendingItemsContent(): string {
  const ready = listSmartNotesWithReady().filter(n => n.ready)
  const bullets: string[] = []
  for (const note of ready) {
    const thought = getThoughtById(note.thought_id)
    if (!thought) continue
    bullets.push(`- ${thought.content.replace(/\s+/g, ' ').trim()} (${note.condition_hit ?? 'ready'})`)
  }
  return bullets.join('\n')
}

// architecture_decisions — primers, most-hit first (FI-07).
function architectureDecisionsContent(db: Database): string {
  const bullets: string[] = []
  for (const primer of getPrimers(db)) {
    const thought = getThoughtById(primer.thought_id)
    if (!thought) continue
    bullets.push(`- ${thought.content.replace(/\s+/g, ' ').trim()}`)
  }
  return bullets.join('\n')
}

export function getSlots(opts?: { projectId?: string; names?: string[] }): SlotView[] {
  const d = getDb()
  const projectId = opts?.projectId || undefined
  const filter = opts?.names?.length ? new Set(opts.names) : null

  const views: SlotView[] = []
  for (const name of SLOT_NAMES) {
    if (filter && !filter.has(name)) continue
    if (VIRTUAL_SLOT_NAMES.has(name)) {
      const maxChars = config.slots.defaultMaxChars
      let content: string
      if (name === 'persona') content = personaContent(d)
      else if (name === 'architecture_decisions') content = architectureDecisionsContent(d)
      else content = pendingItemsContent()
      const { content: truncatedContent, truncated } = truncate(content, maxChars)
      views.push({ name, scope: 'global', virtual: true, content: truncatedContent, truncated, max_chars: maxChars, updated_at: null })
      continue
    }
    // Explicit: project-scoped row wins over the global fallback.
    const row = (projectId ? getSlotRow(d, name, 'project', projectId) : undefined) ?? getSlotRow(d, name, 'global', null)
    const maxChars = row?.max_chars ?? config.slots.defaultMaxChars
    const { content, truncated } = truncate(row?.content ?? '', maxChars)
    views.push({
      name,
      scope: row?.scope ?? 'global',
      virtual: false,
      content,
      truncated,
      max_chars: maxChars,
      updated_at: row?.updated_at ?? null
    })
  }
  return views
}

export interface UpdateSlotInput {
  content: string
  max_chars?: number
  scope?: 'project' | 'global'
  project_id?: string
}

export function updateExplicitSlot(name: string, input: UpdateSlotInput, defaultMaxChars: number): SlotView {
  if (!EXPLICIT_SLOT_NAMES.has(name)) {
    throw new ValidationError(
      `Slot '${name}' is virtual (read-only). Writable slots: ${[...EXPLICIT_SLOT_NAMES].join(', ')}`
    )
  }
  if (typeof input.content !== 'string') {
    throw new ValidationError('content must be a string')
  }
  const maxChars = input.max_chars ?? defaultMaxChars
  if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > 8000) {
    throw new ValidationError('max_chars must be an integer between 100 and 8000')
  }
  const d = getDb()
  const scope = input.scope ?? 'global'
  let scopeId: string | null = null
  if (scope === 'project') {
    if (!input.project_id) throw new ValidationError('project_id is required when scope is "project"')
    const project = d.prepare(`SELECT id FROM projects WHERE id = ?`).get(input.project_id)
    if (!project) throw new NotFoundError('Project not found')
    scopeId = input.project_id
  }
  const row = upsertSlot(d, { name, scope, scope_id: scopeId, content: input.content, max_chars: maxChars })
  const { content, truncated } = truncate(row.content, row.max_chars)
  return {
    name: name as SlotName,
    scope: row.scope,
    virtual: false,
    content,
    truncated,
    max_chars: row.max_chars,
    updated_at: row.updated_at
  }
}

export { type ReflectInput, type ReflectResult, reflectSession } from './session-reflection.service'
