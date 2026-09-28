/**
 * Merge/lifecycle decision for the propose-only placement engine
 * (ADR 2026-09-28, §2.6).
 *
 * Pure and side-effect free: it detects the best lexical near-duplicate in the
 * candidate pool and applies the lifecycle precedence
 * `replaces+archive` > `merge` > `link` > `keep`. It never writes the graph —
 * the returned {@link LifecycleProposal} is advisory only, confirmation always
 * happens through the existing write tools.
 */

import type { Thought } from '../../db/thoughts'
import { clamp01 } from '../../utils'
import { jaccard, normalise } from '../text-similarity'
import type { EdgeProposal, LifecycleProposal } from './types'

/** Near-duplicate threshold; mirrors `session-reflection.service.ts` (Jaccard 0.6). */
const MERGE_OVERLAP_MIN = 0.6

interface MergeTarget {
  id: string
  overlap: number
}

export function keepLifecycle(rationale: string): LifecycleProposal {
  return { action: 'keep', confidence: 0, rationale, review_required: true, blocked_by: [] }
}

/**
 * Best lexical near-duplicate in the pool: exact normalised match or
 * Jaccard >= 0.6 (mirrors `session-reflection.service.ts`), highest overlap
 * first with a `target_id` asc tiebreak. Pure and deterministic.
 */
export function findMergeTarget(pool: Thought[], source: Thought): MergeTarget | undefined {
  const sourceNorm = normalise(source.content)
  let best: MergeTarget | undefined
  for (const candidate of pool) {
    if (candidate.id === source.id || candidate.is_cluster) continue
    const candidateNorm = normalise(candidate.content)
    const exact = sourceNorm.length > 0 && candidateNorm === sourceNorm
    const overlap = exact ? 1 : jaccard(sourceNorm, candidateNorm)
    if (!exact && overlap < MERGE_OVERLAP_MIN) continue
    if (best === undefined || overlap > best.overlap || (overlap === best.overlap && candidate.id < best.id)) {
      best = { id: candidate.id, overlap }
    }
  }
  return best
}

/**
 * Non-throwing equivalent of the merge preconditions (`merge.ts`): the reasons
 * a proposed merge cannot be confirmed, surfaced as `blocked_by[]`.
 */
function mergeBlockers(source: Thought): string[] {
  const blocked: string[] = []
  if (source.status === 'archived') blocked.push('source is archived')
  if (source.is_profile) blocked.push('source is profile')
  return blocked
}

/**
 * Lifecycle precedence (ADR §2.6): `replaces+archive` > `merge` > `link` >
 * `keep`. Deterministic and side-effect free.
 *
 * `replaceEdge` is probed on the *uncapped* proposal list (see
 * {@link proposePlacementPlan}) so a supersede candidate that sorts past
 * `maxProposals` still wins precedence. `emittedEdges` is the post-cap list
 * actually returned in the plan, so the `link` rationale reports the final
 * count.
 */
export function decideLifecycle(
  source: Thought,
  replaceEdge: EdgeProposal | undefined,
  emittedEdges: EdgeProposal[],
  mergeTarget: MergeTarget | undefined,
  degraded: boolean
): LifecycleProposal {
  if (replaceEdge) {
    return {
      action: 'replaces+archive',
      confidence: replaceEdge.confidence,
      rationale: `newer near-duplicate of active target ${replaceEdge.target_id}; propose a replaces edge then archive this thought`,
      review_required: true,
      blocked_by: source.status === 'archived' ? ['source is archived'] : []
    }
  }

  if (mergeTarget) {
    const blocked = mergeBlockers(source)
    return {
      action: 'merge',
      confidence: clamp01(mergeTarget.overlap),
      rationale: `near-duplicate of ${mergeTarget.id} (lexical overlap ${mergeTarget.overlap.toFixed(2)})${blocked.length > 0 ? '; blocked' : ''}`,
      review_required: true,
      blocked_by: blocked
    }
  }

  if (emittedEdges.length > 0) {
    return {
      action: 'link',
      confidence: clamp01(emittedEdges[0].confidence),
      rationale: `${emittedEdges.length} edge proposal(s); highest confidence ${emittedEdges[0].confidence.toFixed(2)} (${emittedEdges[0].rule_id})`,
      review_required: true,
      blocked_by: []
    }
  }

  return keepLifecycle(
    degraded
      ? 'embedder unavailable; no lexical near-duplicate found'
      : 'no edge, placement or near-duplicate proposal above threshold'
  )
}
