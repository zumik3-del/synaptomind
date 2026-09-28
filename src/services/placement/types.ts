/**
 * Propose-only placement policy types (ADR 2026-09-28, §2.1 / §2.5).
 *
 * The policy layer is read-only: every element here is a *proposal* carrying
 * `rationale`, `confidence` and `review_required`. Confirmation always happens
 * through the existing write tools (`memory_store link`, `memory_supersede`,
 * `memory_crystallize`); nothing in this module writes the graph.
 */

import type { GraphStanding } from '../../db/graph-annotations'

/**
 * The specific relation the policy layer may propose for one unordered pair.
 * A typed edge may only be proposed when a non-embedding signal is present;
 * embedding similarity alone yields `related` (ADR #142 / task #927).
 */
export type SemanticEdgeType = 'contradicts' | 'supports' | 'develops' | 'depends_on' | 'replaces' | 'related'

/**
 * Stable identifier of a rule in the declarative table. Appears in every
 * proposal's provenance so a fired decision can be traced back to its rule.
 */
export type RuleId =
  | 'supersede.newer_replaces_older'
  | 'conflict.explicit_negation'
  | 'evidence.cue_supports'
  | 'evolution.develops'
  | 'dependency.blocked_by'
  | 'fallback.embedding_related'

/** Edge directionality; symmetric types follow {@link SYMMETRIC_EDGE_TYPES}. */
export type EdgeDirection = 'directed' | 'symmetric'

/**
 * Creation-time ordering of the pair, from the source's point of view:
 * `'newer'` = source was created after the target, `'older'` = before,
 * `'same'` = identical timestamps.
 */
export type TemporalOrder = 'newer' | 'older' | 'same'

/** Per-thought signals feeding pair-level classification. Pure, no I/O. */
export interface ThoughtSignals {
  id: string
  status: string
  projectId: string
  tags: string[]
  createdAt: string
  /** Lowercased, whitespace-collapsed content (see `text-similarity.normalise`). */
  normalised: string
  /** Distinct negation markers found in the content. */
  negations: string[]
  /** Content carries an evidential marker (`because`, `evidence`, ...). */
  evidentialCue: boolean
  /** Content carries an evolution/change marker (`now`, `updated`, ...). */
  evolutionCue: boolean
  /** Content/tags carry a task or pending marker (`todo`, `pending`, ...). */
  dependencyCue: boolean
}

/**
 * All signals available for one unordered pair. `embeddingSimilarity` is the
 * cosine similarity in `[0, 1]` (`0` when the embedder is unavailable — the
 * lexical-only degraded path); every other field is derived from the two
 * thought rows and their existing edges, never from a model.
 */
export interface PairSignals {
  sourceId: string
  targetId: string
  embeddingSimilarity: number
  /** Word-set Jaccard overlap of the normalised contents. */
  lexicalOverlap: number
  /** `1` when exactly one side is negated, `0` when both or neither are. */
  negationDelta: number
  /** The source carries an evidential cue. */
  evidentialCue: boolean
  /** The source carries an evolution/change cue. */
  evolutionCue: boolean
  /** Creation-time ordering from the source's point of view. */
  temporalOrder: TemporalOrder
  /** Jaccard overlap of the two tag sets (`0` when either side has none). */
  tagOverlap: number
  /** The target carries a task/pending cue. */
  dependencyCue: boolean
  /** Type of the edge already connecting the pair, if any. */
  existingEdgeType: string | null
  sourceStatus: string
  targetStatus: string
  /** Graph standing of the source (from `annotateGraphStanding`). */
  sourceStanding: GraphStanding
  /** Graph standing of the target (from `annotateGraphStanding`). */
  targetStanding: GraphStanding
  sameProject: boolean
}

/** A key of {@link PairSignals}; rules declare the keys they require. */
export type SignalKey = keyof PairSignals

/** A typed (or fallback `related`) edge proposal for one unordered pair. */
export interface EdgeProposal {
  source_id: string
  target_id: string
  type: SemanticEdgeType
  direction: EdgeDirection
  confidence: number
  rationale: string
  review_required: boolean
  /** Which declarative rule fired, for provenance. */
  rule_id: RuleId
  /** Snapshot of the exact inputs that fired the rule. */
  signals: PairSignals
}

/** A placement proposal: an existing cluster or a parent thought. */
export interface PlacementProposal {
  kind: 'cluster' | 'parent'
  target_id: string
  confidence: number
  rationale: string
  review_required: boolean
}

/** Lifecycle move recommended for the thought (ADR §2.6). */
export type LifecycleAction = 'keep' | 'link' | 'merge' | 'replaces+archive'

export interface LifecycleProposal {
  action: LifecycleAction
  confidence: number
  rationale: string
  review_required: boolean
  /** Reasons a proposed move cannot be confirmed, e.g. `['source is profile']`. */
  blocked_by: string[]
}

/** The single per-thought output of the policy engine (ADR §2). */
export interface PlacementPlan {
  thought_id: string
  placement: PlacementProposal | null
  edges: EdgeProposal[]
  lifecycle: LifecycleProposal
  /** True when the embedder was unavailable and signals are lexical-only. */
  degraded: boolean
  generated_at: string
}
