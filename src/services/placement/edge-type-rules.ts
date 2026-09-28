/**
 * Declarative edge-type rule table (ADR 2026-09-28, §2.5).
 *
 * Pure, read-only classification of one {@link PairSignals} snapshot into at
 * most one {@link EdgeProposal}. Rules are evaluated in fixed precedence and
 * the first match wins, mirroring the `CheckDef[]` shape from
 * `health-check.service.ts`.
 *
 * Safety invariant (ADR #142 / task #927): embedding similarity alone MUST
 * yield `related`. Every typed rule lists a non-embedding signal in `requires`,
 * so a semantics-free snapshot can only reach the `fallback.embedding_related`
 * rule. `contradicts` is never inferred from similarity.
 */

import { clamp01 } from '../../utils'
import type {
  EdgeDirection,
  EdgeProposal,
  PairSignals,
  RuleId,
  SemanticEdgeType,
  SignalKey
} from './types'

/** A single ordered rule. `requires` lists the signals the predicate relies on. */
export interface EdgeTypeRule {
  id: RuleId
  type: SemanticEdgeType
  direction: EdgeDirection
  /**
   * All keys must be present AND non-null for the rule to be applicable.
   * Enforced at runtime by {@link classifyEdgeType}.
   */
  requires: SignalKey[]
  predicate(s: PairSignals): boolean
  confidence(s: PairSignals): number
  rationale: string
  reviewRequired: boolean
}

/** Near-duplicate overlap: source is newer, highly overlapping and evolving. */
const SUPERSEDE_OVERLAP_MIN = 0.6
/** Looser overlap: source evolves a related (not duplicate) older target. */
const DEVELOPS_OVERLAP_MIN = 0.3
/** Typed rules that pair a cue with similarity use the edge-detect recall floor. */
const SIMILARITY_MIN = 0.75
/** A one-sided negation against a similar statement is an explicit conflict cue. */
const NEGATION_DELTA_MIN = 0.5

/**
 * Runtime guard for {@link EdgeTypeRule.requires}: a rule is applicable only
 * when every signal key it declares is present and non-null. Keeps the
 * declarative contract honest for future rules whose predicate would otherwise
 * fire on a missing signal.
 */
function requirementsMet(rule: EdgeTypeRule, signals: PairSignals): boolean {
  return rule.requires.every(key => signals[key] !== undefined && signals[key] !== null)
}

/**
 * Ordered rule table, highest precedence first. The `related` fallback is last
 * and is the only rule that may fire on embedding similarity alone.
 */
export const EDGE_TYPE_RULES: EdgeTypeRule[] = [
  {
    id: 'supersede.newer_replaces_older',
    type: 'replaces',
    direction: 'directed',
    requires: ['temporalOrder', 'lexicalOverlap', 'evolutionCue'],
    predicate: s =>
      s.temporalOrder === 'newer' && s.lexicalOverlap >= SUPERSEDE_OVERLAP_MIN && s.evolutionCue,
    confidence: s => clamp01((s.lexicalOverlap + s.embeddingSimilarity) / 2),
    rationale: 'source is newer, near-duplicate and carries an evolution cue; propose replaces (+ archive)',
    reviewRequired: true
  },
  {
    id: 'conflict.explicit_negation',
    type: 'contradicts',
    direction: 'symmetric',
    requires: ['negationDelta', 'embeddingSimilarity'],
    predicate: s => s.negationDelta >= NEGATION_DELTA_MIN && s.embeddingSimilarity >= SIMILARITY_MIN,
    confidence: s => clamp01(s.embeddingSimilarity),
    rationale: 'similar statements with opposite negation polarity; explicit conflict cue',
    reviewRequired: true
  },
  {
    id: 'evidence.cue_supports',
    type: 'supports',
    direction: 'directed',
    requires: ['evidentialCue', 'embeddingSimilarity'],
    predicate: s => s.evidentialCue && s.embeddingSimilarity >= SIMILARITY_MIN,
    confidence: s => clamp01(s.embeddingSimilarity),
    rationale: 'source carries an evidential cue and is similar to the target',
    reviewRequired: true
  },
  {
    id: 'evolution.develops',
    type: 'develops',
    direction: 'directed',
    requires: ['evolutionCue', 'temporalOrder', 'lexicalOverlap'],
    predicate: s =>
      s.evolutionCue && s.temporalOrder === 'newer' && s.lexicalOverlap >= DEVELOPS_OVERLAP_MIN,
    confidence: s => clamp01(s.lexicalOverlap),
    rationale: 'source evolves a related, older target',
    reviewRequired: true
  },
  {
    id: 'dependency.blocked_by',
    type: 'depends_on',
    direction: 'directed',
    requires: ['dependencyCue', 'temporalOrder'],
    predicate: s => s.dependencyCue && s.temporalOrder !== 'same',
    confidence: () => 0.5,
    rationale: 'target carries a task/pending cue and a creation-order cue is present',
    reviewRequired: true
  },
  {
    id: 'fallback.embedding_related',
    type: 'related',
    direction: 'symmetric',
    requires: [],
    predicate: s => s.embeddingSimilarity > 0,
    confidence: s => clamp01(s.embeddingSimilarity),
    rationale: 'embedding_similarity_only',
    reviewRequired: true
  }
]

/**
 * Classify one pair into at most one {@link EdgeProposal}. First match wins;
 * returns `null` only when no rule matches (a pair with no positive embedding
 * similarity and no typed cue). The returned proposal carries the fired rule id
 * and the full signal snapshot for provenance.
 */
export function classifyEdgeType(signals: PairSignals): EdgeProposal | null {
  for (const rule of EDGE_TYPE_RULES) {
    if (!requirementsMet(rule, signals)) continue
    if (!rule.predicate(signals)) continue
    return {
      source_id: signals.sourceId,
      target_id: signals.targetId,
      type: rule.type,
      direction: rule.direction,
      confidence: clamp01(rule.confidence(signals)),
      rationale: rule.rationale,
      review_required: rule.reviewRequired,
      rule_id: rule.id,
      signals
    }
  }
  return null
}
