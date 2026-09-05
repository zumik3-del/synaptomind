import type { SQLQueryBindings } from 'bun:sqlite'
import { getAllActiveEdges } from '../db/edges'
import { getDb } from '../db'
import { getThoughtImportance } from '../db/thoughts'
import { listSmartNotesWithReady } from './smart_notes.service'

export interface FrontierInput {
  project_id?: string
  k?: number
}

export interface FrontierItem {
  thought_id: string
  content_short: string
  reason: 'ready smart note' | 'directive'
  priority: number
  blocked_by: string[]
}

interface CandidateRow {
  id: string
  content: string
  created_at: string
}

const EXCLUDED_SOURCES = ['profile-summary', 'crystal']

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

  const candidates = new Map<string, CandidateRow>()
  const params: SQLQueryBindings[] = []

  // 1) directive/todo-tagged active+draft thoughts
  let sql = `
    SELECT DISTINCT t.id, t.content, t.created_at
    FROM thoughts t
    JOIN thought_tags tt ON tt.thought_id = t.id
    JOIN tags g ON g.id = tt.tag_id AND lower(g.name) IN ('directive','todo')
    WHERE t.status IN ('active','draft')
      AND t.is_cluster = 0
      AND (t.source IS NULL OR t.source NOT IN ('profile-summary','crystal'))`
  if (input.project_id) {
    sql += ` AND t.project_id = ?`
    params.push(input.project_id)
  }
  for (const row of d.prepare(sql).all(...params) as CandidateRow[]) candidates.set(row.id, row)

  // 2) ready smart notes
  const readyReasons = new Set<string>()
  for (const note of listSmartNotesWithReady()) {
    if (!note.ready) continue
    const t = d.prepare(`SELECT id, content, created_at FROM thoughts WHERE id = ?`).get(note.thought_id) as
      | CandidateRow
      | undefined
    if (t && !candidates.has(t.id)) candidates.set(t.id, t)
    if (t) readyReasons.add(t.id)
  }
  if (input.project_id) {
    for (const id of [...candidates.keys()]) {
      const row = d.prepare(`SELECT project_id FROM thoughts WHERE id = ?`).get(id) as
        | { project_id: string }
        | undefined
      if (row?.project_id !== input.project_id) candidates.delete(id)
    }
  }

  // Clusters/crystals/profile summaries never enter the frontier.
  for (const id of [...candidates.keys()]) {
    const row = d.prepare(`SELECT is_cluster, COALESCE(source,'') AS source FROM thoughts WHERE id = ?`).get(id) as
      | { is_cluster: number; source: string }
      | undefined
    if (!row || row.is_cluster === 1 || EXCLUDED_SOURCES.includes(row.source)) candidates.delete(id)
  }

  // 3) replaced thoughts are outdated — out of the plan
  const replaced = new Set(
    (d.prepare(`SELECT DISTINCT target_id FROM edges WHERE type = 'replaces'`).all() as { target_id: string }[]).map(
      r => r.target_id
    )
  )
  for (const id of replaced) candidates.delete(id)

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
