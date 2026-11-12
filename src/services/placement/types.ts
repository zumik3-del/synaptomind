import type { GraphStanding } from '../../db/graph-annotations'

export type SemanticEdgeType =
  | 'contradicts'
  | 'supports'
  | 'develops'
  | 'depends_on'
  | 'replaces'
  | 'related'

export type RuleId =
  | 'supersede.newer_replaces_older'
  | 'conflict.explicit_negation'
  | 'evidence.cue_supports'
  | 'evolution.develops'
  | 'dependency.blocked_by'
  | 'fallback.embedding_related'

export type EdgeDirection = 'directed' | 'symmetric'

export type TemporalOrder = 'newer' | 'older' | 'same'

export interface ThoughtSignals {
  id: string
  status: string
  projectId: string
  tags: string[]
  createdAt: string
  normalised: string
  negations: string[]
  evidentialCue: boolean
  evolutionCue: boolean
  dependencyCue: boolean
}

export interface PairSignals {
  sourceId: string
  targetId: string
  /** `0` on the degraded lexical-only path, which every typed rule must tolerate. */
  embeddingSimilarity: number
  lexicalOverlap: number
  negationDelta: number
  evidentialCue: boolean
  evolutionCue: boolean
  temporalOrder: TemporalOrder
  tagOverlap: number
  dependencyCue: boolean
  existingEdgeType: string | null
  sourceStatus: string
  targetStatus: string
  sourceStanding: GraphStanding
  targetStanding: GraphStanding
  sameProject: boolean
}

export type SignalKey = keyof PairSignals

export interface EdgeProposal {
  source_id: string
  target_id: string
  type: SemanticEdgeType
  direction: EdgeDirection
  confidence: number
  rationale: string
  review_required: boolean
  rule_id: RuleId
  signals: PairSignals
}

export interface PlacementProposal {
  kind: 'cluster' | 'parent'
  target_id: string
  confidence: number
  rationale: string
  review_required: boolean
}

export type LifecycleAction = 'keep' | 'link' | 'merge' | 'replaces+archive'

export interface LifecycleProposal {
  action: LifecycleAction
  confidence: number
  rationale: string
  review_required: boolean
  blocked_by: string[]
  target_id?: string
}

export interface PlacementPlan {
  thought_id: string
  placement: PlacementProposal | null
  edges: EdgeProposal[]
  lifecycle: LifecycleProposal
  degraded: boolean
  generated_at: string
}
