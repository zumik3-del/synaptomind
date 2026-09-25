import { getAllActiveEdges, getReplacedTargetIds } from '../db/edges'
import { findDirectiveCandidates, FRONTIER_EXCLUDED_SOURCES, type FrontierCandidateRow } from '../db/frontier'
import { getDb } from '../db'
import { getThoughtImportance, getThoughtsByIds } from '../db/thoughts'
import { listSmartNotesWithReady } from './smart_notes.service'

interface FrontierInput {
  project_id?: string
  k?: number
}

interface FrontierItem {
  thought_id: string
  content_short: string
  reason: 'ready smart note' | 'directive'
  priority: number
  blocked_by: string[]
}

function shortContent(content: string, limit = 120): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/**
 * Frontier (issue #219) — a deterministic "what to do next" ranking over the
 * thought graph. Candidates are directive/todo-tagged thoughts plus ready
 * smart notes. Replaced thoughts (incoming `replaces` edge) are dropped;
 * upstream candidates block their dependents via `depends_on` edges.
 *
 * priority ∈ [0,1] = 0.5·importance + 0.25·ready + 0.15·unblocked + age bonus.
 */
export function getFrontier(input: FrontierInput = {}): { items: FrontierItem[] } {
  const k = Math.min(Math.max(input.k ?? 10, 1), 50)
  const d = getDb()

  const candidates = new Map<string, FrontierCandidateRow>()

  // 1) directive/todo-tagged active+draft thoughts
  for (const row of findDirectiveCandidates(d, input.project_id)) candidates.set(row.id, row)

  // 2) ready smart notes — archived, off-project, derived (cluster/crystal) or
  // profile-summary thoughts never enter the frontier, even when a stale smart
  // note still evaluates as ready.
  const readyReasons = new Set<string>()
  const readyNotes = listSmartNotesWithReady().filter(note => note.ready)
  const readyThoughts = getThoughtsByIds(d, readyNotes.map(note => note.thought_id))
  for (const note of readyNotes) {
    const t = readyThoughts.get(note.thought_id)
    if (!t || t.status === 'archived') continue
    if (input.project_id && t.project_id !== input.project_id) continue
    if (t.is_cluster === 1 || FRONTIER_EXCLUDED_SOURCES.includes(t.source ?? '')) continue
    readyReasons.add(t.id)
    if (!candidates.has(t.id)) {
      candidates.set(t.id, { id: t.id, content: t.content, created_at: t.created_at })
    }
  }

  // 3) replaced thoughts are outdated — out of the plan
  for (const id of getReplacedTargetIds(d)) candidates.delete(id)

  // 4) upstream blocking inside the candidate set (depends_on)
  const upstreamOf = new Map<string, string[]>()
  for (const edge of getAllActiveEdges(d)) {
    if (!candidates.has(edge.source_id) || !candidates.has(edge.target_id)) continue
    if (edge.type !== 'depends_on') continue
    upstreamOf.set(edge.source_id, [...(upstreamOf.get(edge.source_id) ?? []), edge.target_id])
  }

  const items: FrontierItem[] = []
  for (const c of candidates.values()) {
    const imp = getThoughtImportance(d, c.id)?.importance ?? 1
    const ageDays = Math.max(0, (Date.now() - Date.parse(c.created_at)) / 86_400_000)
    const ageBonus = ageDays <= 7 ? 0.1 : ageDays <= 30 ? 0.05 : 0
    const blockedBy = upstreamOf.get(c.id) ?? []
    const isReady = readyReasons.has(c.id)
    const priority = Math.min(
      1,
      Math.max(0, 0.5 * Math.min(imp, 1) + (isReady ? 0.25 : 0) + (blockedBy.length === 0 ? 0.15 : 0) + ageBonus)
    )
    items.push({
      thought_id: c.id,
      content_short: shortContent(c.content),
      reason: isReady ? 'ready smart note' : 'directive',
      priority: Math.round(priority * 100) / 100,
      blocked_by: blockedBy
    })
  }

  items.sort((a, b) => b.priority - a.priority || a.thought_id.localeCompare(b.thought_id))
  return { items: items.slice(0, k) }
}
