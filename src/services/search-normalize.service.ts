import { config } from '../config'
import { clamp01 } from '../utils'
import type { SearchServiceOptions, SupersessionMode } from './search.service'

const SEARCH_MAX_TOP_K = 1000
const SUPPRESSION_OVERFETCH_FACTOR = 4

const DEFAULT_RECENCY_HALF_LIFE_DAYS = 30
const MIN_RECENCY_HALF_LIFE_DAYS = 1
const MAX_RECENCY_HALF_LIFE_DAYS = 3650
const MAX_RECENCY_WEIGHT = 1

export const DEFAULT_MIN_RELEVANCE = 0.4

function clampTopK(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 10
  return Math.min(Math.max(Math.floor(value), 1), SEARCH_MAX_TOP_K)
}

function clampMinImportance(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.min(Math.max(value, 0), 1)
}

function clampUnitInterval(value: number | undefined): number {
  return clamp01(value ?? 0)
}

function clampRecencyWeight(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.min(Math.max(value, 0), MAX_RECENCY_WEIGHT)
}

function clampRecencyHalfLifeDays(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0)
    return DEFAULT_RECENCY_HALF_LIFE_DAYS
  return Math.min(Math.max(value, MIN_RECENCY_HALF_LIFE_DAYS), MAX_RECENCY_HALF_LIFE_DAYS)
}

export interface NormalizedSearchOptions {
  topK: number
  minImportance: number | undefined
  supersessionMode: SupersessionMode
  minRelevance: number
  confidenceFloor: number
  unrelatedFloor: number
  candidateK: number
  recencyWeight: number
  recencyHalfLifeDays: number
}

export function normalizeSearchOptions(options: SearchServiceOptions): NormalizedSearchOptions {
  const topK = clampTopK(options.topK)
  const minImportance = clampMinImportance(options.minImportance)
  const supersessionMode = options.supersessionMode ?? 'flag'
  const minRelevance =
    options.minRelevance === undefined
      ? DEFAULT_MIN_RELEVANCE
      : clampUnitInterval(options.minRelevance)
  const confidenceFloor =
    options.confidenceFloor !== undefined
      ? clampUnitInterval(options.confidenceFloor)
      : clampUnitInterval(config.search.confidence.vectorFloor)
  const unrelatedFloor = clampUnitInterval(config.search.confidence.unrelatedFloor)
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
    unrelatedFloor,
    candidateK,
    recencyWeight: clampRecencyWeight(options.recencyWeight),
    recencyHalfLifeDays: clampRecencyHalfLifeDays(options.recencyHalfLifeDays)
  }
}
