import { expect, test, describe } from 'bun:test'
import { classifyEdgeType, EDGE_TYPE_RULES } from './edge-type-rules'
import { SYMMETRIC_EDGE_TYPES } from '../../db/edges'
import type { PairSignals } from './types'

function makeSignals(overrides?: Partial<PairSignals>): PairSignals {
  return {
    sourceId: 'src',
    targetId: 'tgt',
    embeddingSimilarity: 0,
    lexicalOverlap: 0,
    negationDelta: 0,
    evidentialCue: false,
    evolutionCue: false,
    temporalOrder: 'same',
    tagOverlap: 0,
    dependencyCue: false,
    existingEdgeType: null,
    sourceStatus: 'active',
    targetStatus: 'active',
    sourceStanding: 'current',
    targetStanding: 'current',
    sameProject: true,
    ...overrides,
  }
}

describe('classifyEdgeType', () => {
  describe('supersede.newer_replaces_older', () => {
    test('fires when newer + high lexical overlap + evolution cue', () => {
      const sig = makeSignals({
        temporalOrder: 'newer',
        lexicalOverlap: 0.8,
        evolutionCue: true,
        embeddingSimilarity: 0.9,
      })
      const proposal = classifyEdgeType(sig)
      expect(proposal).not.toBeNull()
      expect(proposal!.type).toBe('replaces')
      expect(proposal!.rule_id).toBe('supersede.newer_replaces_older')
      expect(proposal!.review_required).toBeTrue()
    })

    test('does not fire when older', () => {
      const sig = makeSignals({
        temporalOrder: 'older',
        lexicalOverlap: 0.8,
        evolutionCue: true,
      })
      expect(classifyEdgeType(sig)).toBeNull()
    })

    test('does not fire when lexical overlap is below threshold', () => {
      const sig = makeSignals({
        temporalOrder: 'newer',
        lexicalOverlap: 0.2,
        evolutionCue: true,
      })
      expect(classifyEdgeType(sig)).toBeNull()
    })

    test('does not fire when no evolution cue', () => {
      const sig = makeSignals({
        temporalOrder: 'newer',
        lexicalOverlap: 0.8,
        evolutionCue: false,
      })
      expect(classifyEdgeType(sig)).toBeNull()
    })
  })

  describe('conflict.explicit_negation', () => {
    test('fires when one-sided negation and high similarity', () => {
      const sig = makeSignals({
        negationDelta: 1,
        embeddingSimilarity: 0.8,
      })
      const proposal = classifyEdgeType(sig)
      expect(proposal).not.toBeNull()
      expect(proposal!.type).toBe('contradicts')
      expect(proposal!.rule_id).toBe('conflict.explicit_negation')
    })

    test('does not fire when both/neither side negated', () => {
      const proposal = classifyEdgeType(makeSignals({ negationDelta: 0, embeddingSimilarity: 0.9 }))
      expect(proposal?.type).not.toBe('contradicts')
    })

    test('does not fire when similarity is below threshold', () => {
      const sig = makeSignals({ negationDelta: 1, embeddingSimilarity: 0.5 })
      const proposal = classifyEdgeType(sig)
      // Fallback fires at > 0, so just assert it is not the conflict rule
      expect(proposal).not.toBeNull()
      expect(proposal!.type).not.toBe('contradicts')
    })
  })

  describe('evidence.cue_supports', () => {
    test('fires when evidential cue and high similarity', () => {
      const sig = makeSignals({ evidentialCue: true, embeddingSimilarity: 0.8 })
      const proposal = classifyEdgeType(sig)
      expect(proposal).not.toBeNull()
      expect(proposal!.type).toBe('supports')
      expect(proposal!.rule_id).toBe('evidence.cue_supports')
    })

    test('does not fire when no evidential cue', () => {
      const proposal = classifyEdgeType(makeSignals({ evidentialCue: false, embeddingSimilarity: 0.9 }))
      expect(proposal?.type).not.toBe('supports')
    })

    test('does not fire when similarity is below threshold', () => {
      const sig = makeSignals({ evidentialCue: true, embeddingSimilarity: 0.5 })
      const proposal = classifyEdgeType(sig)
      // Fallback still fires at > 0, so just assert it is not the evidence rule
      expect(proposal).not.toBeNull()
      expect(proposal!.type).not.toBe('supports')
    })
  })

  describe('evolution.develops', () => {
    test('fires when evolution cue + newer + overlap >= 0.3', () => {
      const sig = makeSignals({ evolutionCue: true, temporalOrder: 'newer', lexicalOverlap: 0.4 })
      const proposal = classifyEdgeType(sig)
      expect(proposal).not.toBeNull()
      expect(proposal!.type).toBe('develops')
      expect(proposal!.rule_id).toBe('evolution.develops')
    })

    test('does not fire when older', () => {
      const sig = makeSignals({ evolutionCue: true, temporalOrder: 'older', lexicalOverlap: 0.5 })
      expect(classifyEdgeType(sig)).toBeNull()
    })

    test('does not fire when overlap is below threshold', () => {
      const sig = makeSignals({ evolutionCue: true, temporalOrder: 'newer', lexicalOverlap: 0.2 })
      expect(classifyEdgeType(sig)).toBeNull()
    })
  })

  describe('dependency.blocked_by', () => {
    test('fires when dependency cue and temporal order is not same', () => {
      const sig = makeSignals({ dependencyCue: true, temporalOrder: 'older' })
      const proposal = classifyEdgeType(sig)
      expect(proposal).not.toBeNull()
      expect(proposal!.type).toBe('depends_on')
      expect(proposal!.rule_id).toBe('dependency.blocked_by')
    })

    test('does not fire when temporal order is same', () => {
      const sig = makeSignals({ dependencyCue: true, temporalOrder: 'same' })
      expect(classifyEdgeType(sig)).toBeNull()
    })

    test('does not fire when no dependency cue', () => {
      expect(classifyEdgeType(makeSignals({ dependencyCue: false, temporalOrder: 'older' }))).toBeNull()
    })
  })

  describe('fallback.embedding_related', () => {
    test('fires when embeddingSimilarity > 0 and no typed rule matches', () => {
      const sig = makeSignals({ embeddingSimilarity: 0.6 })
      const proposal = classifyEdgeType(sig)
      expect(proposal).not.toBeNull()
      expect(proposal!.type).toBe('related')
      expect(proposal!.rule_id).toBe('fallback.embedding_related')
      expect(proposal!.rationale).toBe('embedding_similarity_only')
      expect(proposal!.review_required).toBeTrue()
    })

    test('returns null when similarity is zero and no cues', () => {
      expect(classifyEdgeType(makeSignals())).toBeNull()
    })
  })

  describe('first-match-wins ordering', () => {
    test('supersede wins over conflict when both predicates are true', () => {
      // High overlap, newer, evolution cue (triggers supersede), AND one-sided negation + high similarity (triggers conflict)
      const sig = makeSignals({
        temporalOrder: 'newer',
        lexicalOverlap: 0.8,
        evolutionCue: true,
        negationDelta: 1,
        embeddingSimilarity: 0.9,
      })
      const proposal = classifyEdgeType(sig)
      expect(proposal).not.toBeNull()
      expect(proposal!.type).toBe('replaces')
      expect(proposal!.rule_id).toBe('supersede.newer_replaces_older')
    })

    test('conflict wins over evidence when both predicates are true', () => {
      const sig = makeSignals({
        negationDelta: 1,
        evidentialCue: true,
        embeddingSimilarity: 0.9,
      })
      const proposal = classifyEdgeType(sig)
      expect(proposal).not.toBeNull()
      expect(proposal!.type).toBe('contradicts')
      expect(proposal!.rule_id).toBe('conflict.explicit_negation')
    })
  })

  describe('invariant: semantics-free high similarity => related', () => {
    test('pure embedding signal produces related with rationale embedding_similarity_only', () => {
      const sig = makeSignals({ embeddingSimilarity: 0.95 })
      const proposal = classifyEdgeType(sig)
      expect(proposal).not.toBeNull()
      expect(proposal!.type).toBe('related')
      expect(proposal!.rationale).toBe('embedding_similarity_only')
      expect(proposal!.review_required).toBeTrue()
      // None of the typed rules should have fired
      expect(proposal!.rule_id).toBe('fallback.embedding_related')
    })
  })

  describe('direction consistency', () => {
    test('every rule direction aligns with SYMMETRIC_EDGE_TYPES', () => {
      for (const rule of EDGE_TYPE_RULES) {
        const isSymmetric = SYMMETRIC_EDGE_TYPES.has(rule.type)
        expect(rule.direction === 'symmetric', `${rule.id}: expected symmetric for ${rule.type}`).toBe(isSymmetric)
        expect(rule.direction === 'directed', `${rule.id}: expected directed for ${rule.type}`).toBe(!isSymmetric)
      }
    })
  })

  describe('typed-rule requires a non-embedding signal', () => {
    test('every non-fallback rule lists at least one signal key other than embeddingSimilarity', () => {
      for (const rule of EDGE_TYPE_RULES) {
        if (rule.id === 'fallback.embedding_related') continue
        const hasNonEmbedding = rule.requires.some(k => k !== 'embeddingSimilarity')
        expect(hasNonEmbedding, `${rule.id} requires=${JSON.stringify(rule.requires)} has no non-embedding signal`).toBeTrue()
      }
    })
  })

  describe('proposal provenance', () => {
    test('proposal carries the fired rule id', () => {
      const sig = makeSignals({ dependencyCue: true, temporalOrder: 'older' })
      const proposal = classifyEdgeType(sig)
      expect(proposal!.rule_id).toBe('dependency.blocked_by')
    })

    test('proposal carries the full signals snapshot', () => {
      const sig = makeSignals({ embeddingSimilarity: 0.5, lexicalOverlap: 0.2 })
      const proposal = classifyEdgeType(sig)
      expect(proposal!.signals).toBe(sig)
    })
  })

  describe('requires-enforcement (#955 AC2)', () => {
    test('a typed rule is skipped when a required signal key is null (runtime guard)', () => {
      // dependency.blocked_by requires ['dependencyCue', 'temporalOrder'].
      // When temporalOrder is null the requirementsMet check short-circuits
      // the rule even though dependencyCue is true — the fallback must fire.
      const sig = {
        ...makeSignals({ dependencyCue: true, embeddingSimilarity: 0.85 }),
        temporalOrder: null as unknown as NonNullable<PairSignals['temporalOrder']>,
      }
      const proposal = classifyEdgeType(sig)
      expect(proposal).not.toBeNull()
      expect(proposal!.rule_id).toBe('fallback.embedding_related')
      expect(proposal!.type).toBe('related')
      // Proves the typed rule was NOT selected despite dependencyCue=true.
      expect(proposal!.rule_id).not.toBe('dependency.blocked_by')
    })

    test('a typed rule fires when all required keys are present (positive control)', () => {
      // Same scenario with temporalOrder set → dependency.blocked_by fires.
      const sig = makeSignals({ dependencyCue: true, temporalOrder: 'older' })
      const proposal = classifyEdgeType(sig)
      expect(proposal).not.toBeNull()
      expect(proposal!.rule_id).toBe('dependency.blocked_by')
      expect(proposal!.type).toBe('depends_on')
    })
  })
})
