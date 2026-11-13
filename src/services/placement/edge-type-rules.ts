import { clamp01 } from '../../utils'
import type {
  EdgeDirection,
  EdgeProposal,
  PairSignals,
  RuleId,
  SemanticEdgeType,
  SignalKey
} from './types'

export interface EdgeTypeRule {
  id: RuleId
  type: SemanticEdgeType
  direction: EdgeDirection
  requires: SignalKey[]
  predicate(s: PairSignals): boolean
  confidence(s: PairSignals): number
  rationale: string
  reviewRequired: boolean
}

const SUPERSEDE_OVERLAP_MIN = 0.6
const DEVELOPS_OVERLAP_MIN = 0.3
const SIMILARITY_MIN = 0.75
const NEGATION_DELTA_MIN = 0.5
const CONFLICT_OVERLAP_MIN = 0.5

function requirementsMet(rule: EdgeTypeRule, signals: PairSignals): boolean {
  return rule.requires.every(key => signals[key] !== undefined && signals[key] !== null)
}

// Similarity alone may only yield `related`: every typed rule requires a non-embedding
// signal, and `contradicts` is never inferred from similarity (safety invariant, task #927).
export const EDGE_TYPE_RULES: EdgeTypeRule[] = [
  {
    id: 'supersede.newer_replaces_older',
    type: 'replaces',
    direction: 'directed',
    requires: ['temporalOrder', 'lexicalOverlap', 'evolutionCue'],
    predicate: s =>
      s.temporalOrder === 'newer' && s.lexicalOverlap >= SUPERSEDE_OVERLAP_MIN && s.evolutionCue,
    confidence: s => clamp01((s.lexicalOverlap + s.embeddingSimilarity) / 2),
    rationale:
      'source is newer, near-duplicate and carries an evolution cue; propose replaces (+ archive)',
    reviewRequired: true
  },
  {
    id: 'conflict.explicit_negation',
    type: 'contradicts',
    direction: 'symmetric',
    requires: ['negationDelta', 'embeddingSimilarity', 'lexicalOverlap'],
    predicate: s =>
      s.negationDelta >= NEGATION_DELTA_MIN &&
      s.embeddingSimilarity >= SIMILARITY_MIN &&
      s.lexicalOverlap >= CONFLICT_OVERLAP_MIN,
    confidence: s => clamp01(s.embeddingSimilarity),
    rationale: 'same claim with opposite negation polarity; explicit conflict cue',
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
