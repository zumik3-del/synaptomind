import { getAllActiveEdges, getClusterMembers } from '../db/edges'
import { getDb } from '../db'
import { createThought, getThought, type Thought } from '../db/thoughts'
import { ValidationError } from './errors'
import type { Database } from 'bun:sqlite'

export interface CrystallizeInput {
  thought_ids?: string[]
  cluster_id?: string
  style?: 'runbook' | 'decision-log' | 'overview'
  project_id?: string
}

export interface CrystallizeResult {
  crystal_id: string
  content: string
  style: string
  members_used: number
}

const STYLE_LABELS: Record<string, { main: string; gotchas: string; open: string }> = {
  'decision-log': { main: 'Decisions', gotchas: 'Gotchas', open: 'Open questions' },
  runbook: { main: 'Procedure', gotchas: 'Gotchas', open: 'Open questions' },
  overview: { main: 'Context', gotchas: 'Gotchas', open: 'Open questions' }
}

function hasTag(thought: Thought, name: string): boolean {
  return Array.isArray(thought.tags) && thought.tags.some(t => t.name.toLowerCase() === name)
}

// Topological order over parent/develops edges inside the member set; members
// outside the subgraph or caught in cycles fall back to chronological order.
function topoSort(members: Thought[], db: Database): Thought[] {
  const ids = new Set(members.map(m => m.id))
  const byId = new Map(members.map(m => [m.id, m]))
  const indegree = new Map<string, number>(members.map(m => [m.id, 0]))
  const adjacency = new Map<string, string[]>()
  for (const edge of getAllActiveEdges(db)) {
    if (!ids.has(edge.source_id) || !ids.has(edge.target_id)) continue
    if (edge.type !== 'parent' && edge.type !== 'develops') continue
    // source is upstream (parent/older); target depends on it.
    adjacency.set(edge.source_id, [...(adjacency.get(edge.source_id) ?? []), edge.target_id])
    indegree.set(edge.target_id, (indegree.get(edge.target_id) ?? 0) + 1)
  }

  const chrono = [...members].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const createdAtById = new Map(chrono.map(m => [m.id, m.created_at]))
  const queue = chrono.filter(m => (indegree.get(m.id) ?? 0) === 0).map(m => m.id)
  const ordered: string[] = []
  while (queue.length > 0) {
    // Deterministic tie-break: oldest first.
    queue.sort((a, b) => (createdAtById.get(a) ?? '').localeCompare(createdAtById.get(b) ?? ''))
    const id = queue.shift() as string
    ordered.push(id)
    for (const next of adjacency.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1
      indegree.set(next, left)
      if (left === 0) queue.push(next)
    }
  }
  if (ordered.length < members.length) {
    // Cycle leftovers keep their relative chronological position at the end.
    const rest = chrono.filter(m => !ordered.includes(m.id)).map(m => m.id)
    ordered.push(...rest)
  }
  return ordered.map(id => byId.get(id)).filter((t): t is Thought => Boolean(t))
}

function bullet(thought: Thought): string {
  return `- ${thought.content.replace(/\s+/g, ' ').trim()}`
}

function bucketThoughts(members: Thought[]): Record<string, string[]> {
  const buckets: Record<string, string[]> = { main: [], gotchas: [], open: [] }
  for (const m of members) {
    if (m.status === 'draft') buckets.open.push(bullet(m))
    else if (hasTag(m, 'gotcha')) buckets.gotchas.push(bullet(m))
    else buckets.main.push(bullet(m))
  }
  return buckets
}

function formatCrystallizedMarkdown(
  title: string,
  style: string,
  membersCount: number,
  buckets: Record<string, string[]>
): string {
  const labels = STYLE_LABELS[style]
  const lines: string[] = [`# Crystal: ${title}`, '', `_Style: ${style}; ${membersCount} thought(s) compressed._`, '']
  for (const key of ['main', 'gotchas', 'open'] as const) {
    if (buckets[key].length === 0) continue
    lines.push(`## ${labels[key]}`, ...buckets[key], '')
  }
  return lines.join('\n').trim()
}

export function crystallize(input: CrystallizeInput): CrystallizeResult {
  const style = input.style ?? 'decision-log'
  if (!STYLE_LABELS[style]) throw new ValidationError(`style must be one of: ${Object.keys(STYLE_LABELS).join(', ')}`)

  const db = getDb()
  let title = ''
  let members: Thought[] = []
  if (input.cluster_id) {
    const cluster = db.prepare(`SELECT * FROM thoughts WHERE id = ? AND is_cluster = 1`).get(input.cluster_id) as
      | Thought
      | undefined
    if (!cluster) throw new ValidationError('cluster_id does not reference an existing cluster')
    title = cluster.content.split('\n')[0].replace(/^#\s*/, '').trim()
    members = getClusterMembers(db, cluster.id)
  } else if (input.thought_ids?.length) {
    for (const id of input.thought_ids) {
      const t = getThought(db, id)
      if (t && t.status !== 'archived') members.push(t)
    }
  } else {
    throw new ValidationError('provide thought_ids or cluster_id')
  }

  members = members.filter(m => m.status !== 'archived')
  if (members.length === 0) throw new ValidationError('no non-archived member thoughts to crystallize')

  if (!title) {
    const earliest = [...members].sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
    title = earliest.content.split('\n')[0].slice(0, 80).trim()
  }

  const ordered = topoSort(members, db)
  const buckets = bucketThoughts(ordered)
  const content = formatCrystallizedMarkdown(title, style, members.length, buckets)

  const crystal = createThought(db, {
    content,
    status: 'active',
    source: 'crystal',
    tags: ['crystal', style],
    ...(input.project_id ? { project_id: input.project_id } : {})
  })

  return {
    crystal_id: crystal.id,
    content,
    style,
    members_used: members.length
  }
}
