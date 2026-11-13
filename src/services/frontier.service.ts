import type { Database } from 'bun:sqlite'
import { getAllActiveEdges, getReplacedTargetIds } from '../db/edges'
import { findFrontierCandidates, type FrontierCandidateRow } from '../db/frontier'
import { getDb } from '../db'
import { getThoughtImportance } from '../db/importance'

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

export function listPendingCandidates(
  projectId?: string,
  d: Database = getDb()
): FrontierCandidateRow[] {
  const replaced = new Set(getReplacedTargetIds(d))
  return findFrontierCandidates(d, projectId).filter(c => c.is_pending === 1 && !replaced.has(c.id))
}

export function getFrontierService(
  input: FrontierInput = {},
  d: Database = getDb()
): { items: FrontierItem[] } {
  const limit = Math.min(Math.max(input.k ?? 10, 1), 50)

  const candidates = new Map<string, FrontierCandidateRow>()

  for (const row of findFrontierCandidates(d, input.project_id)) candidates.set(row.id, row)

  for (const id of getReplacedTargetIds(d)) candidates.delete(id)

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
  return { items: items.slice(0, limit) }
}
