import { config, DEFAULTS } from '../config'
import { clampPrimerCount } from '../config.primer-bounds'
import { getDb } from '../db'
import { getPrimers } from '../db/primers'
import { getSlotRow } from '../db/slots'
import { listPendingCandidates } from './frontier.service'
import { getThoughtByIdService } from './thoughts.service'
import type { Database } from 'bun:sqlite'

export const SLOT_NAMES = [
  'pending_items',
  'architecture_decisions',
  'project_context',
  'active_goals'
] as const
type SlotName = (typeof SLOT_NAMES)[number]

const VIRTUAL_SLOT_NAMES = new Set<string>(['pending_items', 'architecture_decisions'])

interface SlotView {
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

function pendingItemsContent(db: Database, limit?: number, offset?: number): string {
  const candidates = listPendingCandidates(undefined, db)
  const start = Math.max(0, offset ?? 0)
  const end = limit !== undefined ? start + Math.max(0, limit) : undefined
  const page = end === undefined ? candidates.slice(start) : candidates.slice(start, end)
  const bullets: string[] = []
  for (const candidate of page) {
    bullets.push(`- ${candidate.content.replace(/\s+/g, ' ').trim()}`)
  }
  return bullets.join('\n')
}

function architectureDecisionsContent(db: Database): string {
  const bullets: string[] = []
  const topN = clampPrimerCount(config.primer.topN, DEFAULTS.primer.topN)
  for (const primer of getPrimers(db, topN)) {
    const thought = getThoughtByIdService(primer.thought_id, db)
    if (!thought) continue
    bullets.push(`- ${thought.content.replace(/\s+/g, ' ').trim()}`)
  }
  return bullets.join('\n')
}

export function getSlots(
  opts?: { projectId?: string; names?: string[]; limit?: number; offset?: number },
  d: Database = getDb()
): SlotView[] {
  const projectId = opts?.projectId || undefined
  const filter = opts?.names?.length ? new Set(opts.names) : null

  const views: SlotView[] = []
  for (const name of SLOT_NAMES) {
    if (filter && !filter.has(name)) continue
    if (VIRTUAL_SLOT_NAMES.has(name)) {
      const maxChars = config.slots.defaultMaxChars
      let content: string
      if (name === 'architecture_decisions') content = architectureDecisionsContent(d)
      else content = pendingItemsContent(d, opts?.limit, opts?.offset)
      const { content: truncatedContent, truncated } = truncate(content, maxChars)
      views.push({
        name,
        scope: 'global',
        virtual: true,
        content: truncatedContent,
        truncated,
        max_chars: maxChars,
        updated_at: null
      })
      continue
    }
    const row =
      (projectId ? getSlotRow(d, name, 'project', projectId) : undefined) ??
      getSlotRow(d, name, 'global', null)
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

export { type ReflectInput, reflectSessionService } from './session-reflection.service'
