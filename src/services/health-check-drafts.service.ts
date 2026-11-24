import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { listThoughts, type Thought } from '../db/thoughts'
import { jaccard, normalise } from './text-similarity.service'

interface DuplicateDraft {
  draft_id: string
  duplicate_of: string
  overlap: number
}

interface MergeTarget {
  id: string
  overlap: number
}

// Mirrors `session-reflection.service.ts`: both must agree on the near-duplicate threshold.
const MERGE_OVERLAP_MIN = 0.6

export function isScheduledReminder(t: Thought, now: string): boolean {
  if (t.tags.some(tag => tag.name.toLowerCase() === 'pending')) return true
  return t.surface_after !== null && t.surface_after > now
}

function buildCandidatePool(
  d: Database,
  thought: Thought,
  projectId: string,
  maxCandidates: number
): Thought[] {
  const pool = listThoughts(d, {
    status: 'active',
    project_id: projectId,
    limit: maxCandidates
  }).filter(t => !t.is_cluster)
  if (!pool.some(t => t.id === thought.id)) pool.unshift(thought)
  return pool
}

function findMergeTarget(pool: Thought[], source: Thought): MergeTarget | undefined {
  const sourceNorm = normalise(source.content)
  let best: MergeTarget | undefined
  for (const candidate of pool) {
    if (candidate.id === source.id || candidate.is_cluster) continue
    const candidateNorm = normalise(candidate.content)
    const exact = sourceNorm.length > 0 && candidateNorm === sourceNorm
    const overlap = exact ? 1 : jaccard(sourceNorm, candidateNorm)
    if (!exact && overlap < MERGE_OVERLAP_MIN) continue
    if (
      best === undefined ||
      overlap > best.overlap ||
      (overlap === best.overlap && candidate.id < best.id)
    ) {
      best = { id: candidate.id, overlap }
    }
  }
  return best
}

export function findDuplicateDrafts(
  d: Database,
  now: string = new Date().toISOString()
): DuplicateDraft[] {
  const findings: DuplicateDraft[] = []
  for (const draft of listThoughts(d, { status: 'draft', limit: null })) {
    if (draft.is_cluster) continue
    if (isScheduledReminder(draft, now)) continue
    const pool = buildCandidatePool(d, draft, draft.project_id, config.edgeDetect.maxCandidates)
    const target = findMergeTarget(pool, draft)
    if (target)
      findings.push({ draft_id: draft.id, duplicate_of: target.id, overlap: target.overlap })
  }
  return findings
}
