/**
 * Pure signal extraction for the placement policy layer (ADR 2026-09-28, P2).
 *
 * Computes the non-embedding cues (lexical overlap, negation polarity,
 * evidential/evolution/dependency cues, temporal order, tags, graph standing)
 * plus the embedding similarity for one unordered pair. Read-only: it reuses
 * existing db read helpers (`searchThoughts`, `getEdgePairBetween`,
 * `annotateGraphStanding`) and never writes.
 */

import type { Database } from 'bun:sqlite'
import { getDb } from '../../db'
import { getEdgePairBetween } from '../../db/edges'
import { annotateGraphStanding } from '../../db/graph-annotations'
import { searchThoughts } from '../../db/search'
import type { Thought } from '../../db/thoughts'
import type { SearchNeighborsFn } from '../edge-candidates.service'
import { jaccard, normalise } from '../text-similarity'
import { clamp01 } from '../../utils'
import type { PairSignals, TemporalOrder, ThoughtSignals } from './types'

const DEFAULT_TOP_K = 10

const NEGATION_RE =
  /\b(?:not|no|never|cannot|can't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|won't|wouldn't|shouldn't|couldn't|without|none|neither|nor)\b/g

const EVIDENTIAL_RE =
  /\b(?:because|since|evidence|confirms?|confirmed|shows?|shown|proves?|proven|therefore|thus|hence|stud(?:y|ies)|research|data|measure(?:d|ment)|observ(?:ed|ation))\b/g

const EVOLUTION_RE =
  /\b(?:now|updated?|changed?|instead|revis(?:ed|ion)|replac(?:e|es|ed)|supersed(?:e|es|ed)|deprecated|obsolete|newer|previously|longer)\b/g

const DEPENDENCY_TAGS = new Set(['pending', 'todo', 'blocked', 'task'])
const DEPENDENCY_RE = /^\s*(?:todo|pending|blocked|task)\b/i

/** Distinct substrings of `text` matched by the global regex `re`. */
function matches(re: RegExp, text: string): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(re)) found.add(m[0])
  return [...found]
}

/** Set Jaccard over tag names; `0` when either side is empty. */
function setJaccard(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a)
  const setB = new Set(b)
  if (setA.size === 0 || setB.size === 0) return 0
  let overlap = 0
  for (const x of setA) if (setB.has(x)) overlap++
  return overlap / (setA.size + setB.size - overlap)
}

/** Creation-time ordering of the source relative to the target. */
function compareTemporal(a: string, b: string): TemporalOrder {
  if (a === b) return 'same'
  return a > b ? 'newer' : 'older'
}

/**
 * Extract the per-thought signals for a single thought. Pure: reads only the
 * passed row, never the database.
 */
export function extractThoughtSignals(thought: Thought): ThoughtSignals {
  const normalised = normalise(thought.content)
  const tags = thought.tags.map(t => t.name.toLowerCase())
  return {
    id: thought.id,
    status: thought.status,
    projectId: thought.project_id,
    tags,
    createdAt: thought.created_at,
    normalised,
    negations: matches(NEGATION_RE, normalised),
    evidentialCue: matches(EVIDENTIAL_RE, normalised).length > 0,
    evolutionCue: matches(EVOLUTION_RE, normalised).length > 0,
    dependencyCue: tags.some(t => DEPENDENCY_TAGS.has(t)) || DEPENDENCY_RE.test(thought.content)
  }
}

export interface PairSignalOptions {
  /** Clock override for deterministic tests (fallback when `created_at` is empty). */
  now?: string
  /** Pre-computed cosine similarity; takes precedence over `embedding`. */
  embeddingSimilarity?: number
  /** Source embedding used to look the target up via `searchThoughts`. */
  embedding?: Float32Array
  /** Neighbour count for the embedding lookup (default 10). */
  topK?: number
}

/** Injectable dependencies (same shape as `EdgeDetectDeps`). */
export interface PairSignalDeps {
  searchNeighbors?: SearchNeighborsFn
  /**
   * Pre-computed `annotateGraphStanding` map covering the source and target.
   * Lets a pair loop replace the per-pair lookup (2 queries each) with one
   * batched call. Falls back to a single-pair lookup when omitted.
   */
  standing?: ReturnType<typeof annotateGraphStanding>
}

function resolveEmbeddingSimilarity(
  source: Thought,
  target: Thought,
  options: PairSignalOptions,
  deps: PairSignalDeps,
  d: Database
): number {
  if (options.embeddingSimilarity !== undefined) return clamp01(options.embeddingSimilarity)
  const embedding = options.embedding
  if (!embedding || embedding.length === 0) return 0
  const topK = options.topK ?? DEFAULT_TOP_K

  if (deps.searchNeighbors) {
    try {
      const hit = deps.searchNeighbors(source.id, embedding, topK).find(n => n.id === target.id)
      return hit ? clamp01(hit.similarity) : 0
    } catch {
      return 0
    }
  }

  try {
    const hit = searchThoughts(d, { embedding, topK, hybrid: false }).find(r => r.thought.id === target.id)
    return hit ? clamp01(hit.similarity) : 0
  } catch {
    return 0
  }
}

/**
 * Compute every {@link PairSignals} field for one unordered pair. Never throws:
 * a missing/unusable embedding yields `embeddingSimilarity: 0` and the
 * lexical-only signals stay valid (the degraded path).
 */
export function extractPairSignals(
  source: Thought,
  target: Thought,
  options: PairSignalOptions = {},
  deps: PairSignalDeps = {},
  d: Database = getDb()
): PairSignals {
  const now = options.now ?? new Date().toISOString()
  const sourceSignals = extractThoughtSignals(source)
  const targetSignals = extractThoughtSignals(target)
  const standing = deps.standing ?? annotateGraphStanding(d, [source.id, target.id])
  const sourceNegated = sourceSignals.negations.length > 0
  const targetNegated = targetSignals.negations.length > 0

  return {
    sourceId: source.id,
    targetId: target.id,
    embeddingSimilarity: resolveEmbeddingSimilarity(source, target, options, deps, d),
    lexicalOverlap: jaccard(sourceSignals.normalised, targetSignals.normalised),
    negationDelta: sourceNegated === targetNegated ? 0 : 1,
    evidentialCue: sourceSignals.evidentialCue,
    evolutionCue: sourceSignals.evolutionCue,
    temporalOrder: compareTemporal(sourceSignals.createdAt || now, targetSignals.createdAt || now),
    tagOverlap: setJaccard(sourceSignals.tags, targetSignals.tags),
    dependencyCue: targetSignals.dependencyCue,
    existingEdgeType: getEdgePairBetween(d, source.id, target.id)?.type ?? null,
    sourceStatus: source.status,
    targetStatus: target.status,
    sourceStanding: standing.get(source.id)?.standing ?? 'current',
    targetStanding: standing.get(target.id)?.standing ?? 'current',
    sameProject: source.project_id === target.project_id
  }
}
