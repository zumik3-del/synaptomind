import { shapeThought, type BatchUrlLinks } from '../utils'
import type { GroupedResult, SearchResult } from '../../../services/search.service'

export interface SearchScores {
  similarity?: number
  distance?: number
  rrf_score?: number
  bm25_score?: number
  relevance?: number
  recency_score?: number
  final_score?: number
}

// Safety annotations (`standing` when not `current`, `superseded_by`, `contradicted_by`,
// `low_confidence: true`) must survive any `compact`/`fields` selection: a contested hit may never
// look clean because the caller used the default output.
export interface SearchItem {
  thought: unknown
  scores?: SearchScores
  standing?: string
  match_source?: string[]
  low_confidence?: boolean
  superseded_by?: string[]
  contradicted_by?: string[]
}

export interface GroupedSearchItem {
  cluster: GroupedResult['cluster']
  items: SearchItem[]
}

const SCORE_KEYS = [
  'similarity',
  'distance',
  'rrf_score',
  'bm25_score',
  'relevance',
  'recency_score',
  'final_score'
] as const

function buildScores(result: SearchResult): SearchScores {
  const scores: SearchScores = {}
  for (const key of SCORE_KEYS) {
    const value = result[key]
    if (value !== undefined) scores[key] = value
  }
  return scores
}

function applyAnnotations(item: SearchItem, result: SearchResult, full: boolean): void {
  const standing = result.standing
  if (standing !== undefined && (full || standing !== 'current')) item.standing = standing

  const supersededBy = result.superseded_by
  if (supersededBy !== undefined && (full || supersededBy.length > 0))
    item.superseded_by = supersededBy

  const contradictedBy = result.contradicted_by
  if (contradictedBy !== undefined && (full || contradictedBy.length > 0))
    item.contradicted_by = contradictedBy

  const lowConfidence = result.low_confidence
  if (lowConfidence !== undefined && (full || lowConfidence)) item.low_confidence = lowConfidence

  if (full && result.match_source !== undefined) item.match_source = result.match_source
}

export function shapeSearchItem(
  result: SearchResult | GroupedResult,
  compact: boolean,
  fields: unknown,
  urlLinks?: BatchUrlLinks
): SearchItem | GroupedSearchItem {
  if ('cluster' in result) {
    return {
      cluster: result.cluster,
      items: (result.items ?? []).map(
        inner => shapeSearchItem(inner, compact, fields, urlLinks) as SearchItem
      )
    }
  }
  const thought = shapeThought(result.thought, compact, fields, urlLinks)
  const explicitFields = Array.isArray(fields)
    ? fields.length > 0
    : typeof fields === 'string' && fields.trim().length > 0
  const full = !compact && !explicitFields
  const flat = result as SearchResult
  const item: SearchItem = { thought }
  applyAnnotations(item, flat, full)
  if (!full) return item
  const scores = buildScores(flat)
  if (Object.keys(scores).length > 0) item.scores = scores
  return item
}
