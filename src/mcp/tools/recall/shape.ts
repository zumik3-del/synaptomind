import { shapeThought } from '../utils'
import type { GroupedResult, SearchResult } from '../../../services/search.service'

/** Score keys moved out of the thought item into `scores` (compact=false). */
export interface SearchScores {
  similarity?: number
  distance?: number
  rrf_score?: number
  bm25_score?: number
  relevance?: number
  /** Recency decay `0.5^(ageDays/halfLifeDays)`, present only with recency_weight > 0. */
  recency_score?: number
  /** Combined ordering key `relevance + weight × recency_score`, same condition. */
  final_score?: number
}

/**
 * One search hit on the wire.
 *
 * The thought always lives under `thought`. Two different kinds of extras sit
 * beside it, and only one of them is optional:
 *
 * - Safety annotations (`standing` when it is not `current`, `superseded_by`,
 *   `contradicted_by`, `low_confidence: true`) are always present when they
 *   apply, whatever `compact`/`fields` say: a superseded, contradicted or
 *   low-confidence hit must never look like a clean one because the caller
 *   used the default output.
 * - Ranking metadata (`scores`, `match_source`, and `standing: 'current'` as a
 *   neutral marker) is opt-in behind `compact: false` and is dropped by an
 *   explicit `fields` selection.
 */
export interface SearchItem {
  thought: unknown
  scores?: SearchScores
  standing?: string
  match_source?: string[]
  low_confidence?: boolean
  superseded_by?: string[]
  contradicted_by?: string[]
}

/** A cluster group of hits (`group_by_cluster=true`): the cluster plus its members. */
export interface GroupedSearchItem {
  cluster: GroupedResult['cluster']
  items: SearchItem[]
}

/** Score keys, in the documented order. */
const SCORE_KEYS = ['similarity', 'distance', 'rrf_score', 'bm25_score', 'relevance', 'recency_score', 'final_score'] as const

function buildScores(result: SearchResult): SearchScores {
  const scores: SearchScores = {}
  for (const key of SCORE_KEYS) {
    const value = result[key]
    if (value !== undefined) scores[key] = value
  }
  return scores
}

/**
 * Copy the safety annotations that apply to one hit onto its item.
 *
 * `full` (compact=false without a `fields` selection) also copies the neutral
 * `standing: 'current'`, `low_confidence: false` and `match_source` values, so
 * the opt-in full output keeps describing every hit completely. In the compact
 * mode only the annotations that change how a hit must be read are emitted.
 */
function applyAnnotations(item: SearchItem, result: SearchResult, full: boolean): void {
  const standing = result.standing
  if (standing !== undefined && (full || standing !== 'current')) item.standing = standing

  const supersededBy = result.superseded_by
  if (supersededBy !== undefined && (full || supersededBy.length > 0)) item.superseded_by = supersededBy

  const contradictedBy = result.contradicted_by
  if (contradictedBy !== undefined && (full || contradictedBy.length > 0)) item.contradicted_by = contradictedBy

  const lowConfidence = result.low_confidence
  if (lowConfidence !== undefined && (full || lowConfidence)) item.low_confidence = lowConfidence

  if (full && result.match_source !== undefined) item.match_source = result.match_source
}

/** Shape one search hit (flat, or a cluster group with its members). */
export function shapeSearchItem(
  result: SearchResult | GroupedResult,
  compact: boolean,
  fields: unknown
): SearchItem | GroupedSearchItem {
  if ('cluster' in result) {
    return {
      cluster: result.cluster,
      items: (result.items ?? []).map((inner) => shapeSearchItem(inner, compact, fields) as SearchItem)
    }
  }
  const thought = shapeThought(result.thought, compact, fields)
  const explicitFields = Array.isArray(fields)
    ? fields.length > 0
    : (typeof fields === 'string' && fields.trim().length > 0)
  const full = !compact && !explicitFields
  const flat = result as SearchResult
  const item: SearchItem = { thought }
  applyAnnotations(item, flat, full)
  if (!full) return item
  const scores = buildScores(flat)
  if (Object.keys(scores).length > 0) item.scores = scores
  return item
}
