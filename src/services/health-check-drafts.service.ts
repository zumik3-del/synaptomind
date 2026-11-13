import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { listThoughts, type Thought } from '../db/thoughts'
import { findMergeTarget } from './placement/lifecycle'
import { buildCandidatePool } from './placement/placement'

export interface DuplicateDraft {
  draft_id: string
  duplicate_of: string
  overlap: number
}

export function isScheduledReminder(t: Thought, now: string): boolean {
  if (t.tags.some(tag => tag.name.toLowerCase() === 'pending')) return true
  return t.surface_after !== null && t.surface_after > now
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
