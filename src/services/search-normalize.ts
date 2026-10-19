/**
 * Search option clamps and normalization, split out of `search.service.ts` so
 * that module keeps its orchestration focus and stays under the project's
 * 350-line file convention (AGENTS.md §4).
 *
 * Request parsing (query-string → params) stays in `search-options.ts`; this
 * module is the other half — the already-parsed options → clamped, defaults
 * resolved, candidate-pool width derived. Keeping the two apart means the HTTP
 * API and the MCP tool share one parsing path without dragging the ranking
 * knobs into it.
 *
 * Types are imported from `search.service.ts` type-only, so there is no runtime
 * edge back (same pattern as `search-options.ts`).
 */

import { config } from '../config'
import type { SearchServiceOptions, SupersessionMode } from './search.service'

const SEARCH_MAX_TOP_K = 1000
/**
 * Candidate-pool multiplier used when `supersessionMode === 'suppress'`: rows are
 * dropped after the DB fetch, so the pool must be widened to still return `topK`
 * surviving results. The widened pool is capped at `SEARCH_MAX_TOP_K`.
 */
const SUPPRESSION_OVERFETCH_FACTOR = 4

/** Default recency-boost half-life (days) when the caller omits it. */
const DEFAULT_RECENCY_HALF_LIFE_DAYS = 30
/** Lower half-life bound (days); `<= 0`/non-finite falls back to the default. */
const MIN_RECENCY_HALF_LIFE_DAYS = 1
/** Upper half-life bound (days). */
const MAX_RECENCY_HALF_LIFE_DAYS = 3650
/** Upper recency-weight bound (inclusive); `0` disables the boost. */
const MAX_RECENCY_WEIGHT = 1

function clampTopK(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 10
  return Math.min(Math.max(Math.floor(value), 1), SEARCH_MAX_TOP_K)
}

function clampMinImportance(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.min(Math.max(value, 0), 1)
}

/**
 * Clamp a `[0, 1]` knob (`min_relevance`, `confidenceFloor`). Non-finite or
 * absent ⇒ `0`, the neutral "off" value for both.
 */
function clampUnitInterval(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.min(Math.max(value, 0), 1)
}

function clampRecencyWeight(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.min(Math.max(value, 0), MAX_RECENCY_WEIGHT)
}

function clampRecencyHalfLifeDays(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_RECENCY_HALF_LIFE_DAYS
  return Math.min(Math.max(value, MIN_RECENCY_HALF_LIFE_DAYS), MAX_RECENCY_HALF_LIFE_DAYS)
}

/**
 * Normalized view of {@link SearchServiceOptions}: every numeric knob is
 * clamped to its valid range, defaults are resolved, and the DB candidate-pool
 * width (`candidateK`) is derived so post-fetch filters (suppression, relevance
 * gate) can backfill up to `topK`.
 */
export interface NormalizedSearchOptions {
  topK: number
  minImportance: number | undefined
  supersessionMode: SupersessionMode
  minRelevance: number
  confidenceFloor: number
  candidateK: number
  recencyWeight: number
  recencyHalfLifeDays: number
}

export function normalizeSearchOptions(options: SearchServiceOptions): NormalizedSearchOptions {
  const topK = clampTopK(options.topK)
  const minImportance = clampMinImportance(options.minImportance)
  const supersessionMode = options.supersessionMode ?? 'flag'
  const minRelevance = clampUnitInterval(options.minRelevance)
  const confidenceFloor =
    options.confidenceFloor !== undefined
      ? clampUnitInterval(options.confidenceFloor)
      : clampUnitInterval(config.search.confidence.vectorFloor)
  // Suppression and the relevance gate both drop rows after the DB fetch, so
  // widen the candidate pool to backfill the survivors up to `topK` (bounded by
  // SEARCH_MAX_TOP_K).
  const candidateK =
    supersessionMode === 'suppress' || minRelevance > 0
      ? Math.min(SEARCH_MAX_TOP_K, topK * SUPPRESSION_OVERFETCH_FACTOR)
      : topK
  return {
    topK,
    minImportance,
    supersessionMode,
    minRelevance,
    confidenceFloor,
    candidateK,
    recencyWeight: clampRecencyWeight(options.recencyWeight),
    recencyHalfLifeDays: clampRecencyHalfLifeDays(options.recencyHalfLifeDays)
  }
}