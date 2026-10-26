/**
 * The `duplicate_drafts` health finding (task #1946).
 *
 * A plain draft that is a near-duplicate of a live active thought needs a human
 * decision: merge/archive the draft, or keep it. The retired draft-triage
 * subsystem used to enqueue that decision into the proposal queue; the finding
 * keeps the signal as a read-only diagnostic instead.
 *
 * The classifier is the engine's own lexical rule — the same candidate pool
 * ({@link buildCandidatePool}) and near-duplicate rule ({@link findMergeTarget})
 * the placement engine uses — so this module never calls the embedder, never
 * consults a model and imports no writer.
 */

import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { listThoughts, type Thought } from '../db/thoughts'
import { findMergeTarget } from './placement/lifecycle'
import { buildCandidatePool } from './placement/placement'

/** One draft whose content duplicates a live active thought. */
export interface DuplicateDraft {
  draft_id: string
  /** The active thought the draft duplicates. */
  duplicate_of: string
  /** Lexical overlap (Jaccard, or 1 for an exact normalised match). */
  overlap: number
}

/**
 * A scheduled reminder must never be flagged (ADR 2026-09-29 §2.5): the
 * `pending` tag or a future `surface_after` marks it as intentionally deferred.
 * `now` is the comparison clock, so the check is deterministic.
 *
 * The tag match is case-insensitive to stay consistent with the frontier query
 * (`lower(name) = 'pending'`): a `Pending`-tagged draft is a reminder there and
 * must be a reminder here too.
 */
export function isScheduledReminder(t: Thought, now: string): boolean {
  if (t.tags.some(tag => tag.name.toLowerCase() === 'pending')) return true
  return t.surface_after !== null && t.surface_after > now
}

/**
 * Every plain draft that has an active near-duplicate, one finding per draft.
 * Clusters and scheduled reminders are excluded (exactly the drafts the retired
 * triage guarded), and the duplicate is always an `active`
 * thought of the draft's own project — the pool is project-scoped and holds
 * active thoughts only.
 */
export function findDuplicateDrafts(d: Database, now: string = new Date().toISOString()): DuplicateDraft[] {
  const findings: DuplicateDraft[] = []
  for (const draft of listThoughts(d, { status: 'draft', limit: null })) {
    if (draft.is_cluster) continue
    if (isScheduledReminder(draft, now)) continue
    const pool = buildCandidatePool(d, draft, draft.project_id, config.edgeDetect.maxCandidates)
    const target = findMergeTarget(pool, draft)
    if (target) findings.push({ draft_id: draft.id, duplicate_of: target.id, overlap: target.overlap })
  }
  return findings
}
