import type { Database } from 'bun:sqlite'
import { getAllActiveEdges, getReplacedTargetIds } from '../db/edges'
import { findFrontierCandidates, type FrontierCandidateRow } from '../db/frontier'
import { getDb } from '../db'
import { getThoughtImportance } from '../db/thoughts'

interface FrontierInput {
  project_id?: string
  k?: number
}

interface FrontierItem {
  thought_id: string
  content_short: string
  reason: 'pending' | 'directive'
  priority: number
  blocked_by: string[]
}

function shortContent(content: string, limit = 120): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/**
 * Pending candidates — due `pending`-tagged thoughts, minus `replaces` targets.
 * Shared with the `pending_items` slot so both surfaces agree on what is due.
 */
export function listPendingCandidates(d: Database, projectId?: string): FrontierCandidateRow[] {
  const replaced = new Set(getReplacedTargetIds(d))
  return findFrontierCandidates(d, projectId).filter(c => c.is_pending === 1 && !replaced.has(c.id))
}

/**
 * Frontier (issue #219) — a deterministic "what to do next" ranking over the
 * thought graph. Candidates are directive/todo/pending-tagged thoughts whose
 * optional `surface_after` delay has elapsed. Replaced thoughts (incoming
 * `replaces` edge) are dropped; upstream candidates block their dependents via
 * `depends_on` edges.
 *
 * priority ∈ [0,1] = 0.5·importance + 0.15·unblocked + age bonus.
 */
export function getFrontier(input: FrontierInput = {}): { items: FrontierItem[] } {
  const k = Math.min(Math.max(input.k ?? 10, 1), 50)
  const d = getDb()

  const candidates = new Map<string, FrontierCandidateRow>()

  // 1) directive/todo/pending-tagged active+draft thoughts that are due
  for (const row of findFrontierCandidates(d, input.project_id)) candidates.set(row.id, row)

  // 2) replaced thoughts are outdated — out of the plan
  for (const id of getReplacedTargetIds(d)) candidates.delete(id)

  // 3) upstream blocking inside the candidate set (depends_on)
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
    const priority = Math.min(
      1,
      Math.max(0, 0.5 * Math.min(imp, 1) + (blockedBy.length === 0 ? 0.15 : 0) + ageBonus)
    )
    items.push({
      thought_id: c.id,
      content_short: shortContent(c.content),
      reason: c.is_pending === 1 ? 'pending' : 'directive',
      priority: Math.round(priority * 100) / 100,
      blocked_by: blockedBy
    })
  }

  items.sort((a, b) => b.priority - a.priority || a.thought_id.localeCompare(b.thought_id))
  return { items: items.slice(0, k) }
}
