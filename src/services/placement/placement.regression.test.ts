import { beforeEach, afterEach, expect, test, describe } from 'bun:test'
import { createTestDb } from '../../test/helpers'
import { closeDb } from '../../db'
import { seedThought } from '../../test/helpers'
import { classifyEdgeType } from './edge-type-rules'
import { extractThoughtSignals, extractPairSignals } from './signals'
import type { PairSignals } from './types'
import type { Thought } from '../../db/thoughts'
import type { Tag } from '../../db/tags'

beforeEach(createTestDb)
afterEach(closeDb)

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
    ...overrides
  }
}

function makeThought(overrides?: Partial<Thought>): Thought {
  const tagNames = overrides?.tags?.map(t => t.name) ?? []
  const tagsObj = tagNames.map((name: string) => ({ name, id: '' })) as unknown as Tag[]
  return {
    id: 't-' + Math.random().toString(36).slice(2),
    content: 'test thought',
    status: 'active',
    tags: tagsObj,
    source: null,
    project_id: 'default',
    is_cluster: 0,
    is_protected: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    archived_at: null,
    surface_after: null,
    ...overrides
  } as Thought
}

describe('prod FP regression: low-overlap negation degrades to related', () => {
  test.each([
    [0.85, 0.01],
    [0.85, 0.05],
    [0.85, 0.106],
    [0.9, 0.01],
    [0.9, 0.05],
    [0.9, 0.106],
    [0.95, 0.01],
    [0.95, 0.05],
    [0.95, 0.106]
  ])(
    'negationDelta=1 + similarity=%p + lexicalOverlap=%p => related, not contradicts',
    (sim, overlap) => {
      const sig = makeSignals({
        negationDelta: 1,
        embeddingSimilarity: sim,
        lexicalOverlap: overlap
      })
      const proposal = classifyEdgeType(sig)
      expect(proposal).not.toBeNull()
      expect(proposal!.type).toBe('related')
      expect(proposal!.rule_id).toBe('fallback.embedding_related')
      expect(proposal!.rationale).toBe('embedding_similarity_only')
      expect(proposal!.review_required).toBeTrue()
    }
  )
})

describe('positive control: high-overlap negation fires conflict.explicit_negation', () => {
  test.each([
    [0.75, 0.5],
    [0.8, 0.55],
    [0.9, 0.7],
    [0.95, 0.8]
  ])('negationDelta=1 + similarity=%p + lexicalOverlap=%p => contradicts', (sim, overlap) => {
    const sig = makeSignals({
      negationDelta: 1,
      embeddingSimilarity: sim,
      lexicalOverlap: overlap
    })
    const proposal = classifyEdgeType(sig)
    expect(proposal).not.toBeNull()
    expect(proposal!.type).toBe('contradicts')
    expect(proposal!.rule_id).toBe('conflict.explicit_negation')
    expect(proposal!.review_required).toBeTrue()
  })
})

describe('boundary: lexicalOverlap = 0.5 is the contradicts threshold', () => {
  test('at 0.5: contradicts fires', () => {
    const sig = makeSignals({
      negationDelta: 1,
      embeddingSimilarity: 0.85,
      lexicalOverlap: 0.5
    })
    const proposal = classifyEdgeType(sig)
    expect(proposal).not.toBeNull()
    expect(proposal!.type).toBe('contradicts')
    expect(proposal!.rule_id).toBe('conflict.explicit_negation')
  })

  test('just below 0.5 (0.499): does not fire contradicts, falls through to related', () => {
    const sig = makeSignals({
      negationDelta: 1,
      embeddingSimilarity: 0.85,
      lexicalOverlap: 0.499
    })
    const proposal = classifyEdgeType(sig)
    expect(proposal).not.toBeNull()
    expect(proposal!.type).not.toBe('contradicts')
    expect(proposal!.rule_id).toBe('fallback.embedding_related')
    expect(proposal!.rationale).toBe('embedding_similarity_only')
  })

  test('well below 0.5 (0.3): definitely not contradicts', () => {
    const sig = makeSignals({
      negationDelta: 1,
      embeddingSimilarity: 0.9,
      lexicalOverlap: 0.3
    })
    const proposal = classifyEdgeType(sig)
    expect(proposal).not.toBeNull()
    expect(proposal!.type).toBe('related')
    expect(proposal!.rule_id).toBe('fallback.embedding_related')
  })
})

describe('dependencyCue regression (task #985 AC3)', () => {
  test('"Task #956 (tester) in review: ..." prefix yields dependencyCue=false', () => {
    const t = makeThought({
      content: 'Task #956 (tester) in review: tighten placement predicates',
      tags: []
    })
    const s = extractThoughtSignals(t)
    expect(s.dependencyCue).toBeFalse()
  })

  test('the `task` tag yields dependencyCue=true', () => {
    const t = makeThought({
      content: 'some note about the task',
      tags: [{ name: 'task', id: '' }] as Tag[]
    })
    const s = extractThoughtSignals(t)
    expect(s.dependencyCue).toBeTrue()
  })

  test('TODO: prefix yields dependencyCue=true', () => {
    const t = makeThought({
      content: 'TODO: finish the placement tests',
      tags: []
    })
    const s = extractThoughtSignals(t)
    expect(s.dependencyCue).toBeTrue()
  })

  test('pending prefix yields dependencyCue=true', () => {
    const t = makeThought({
      content: 'pending review of the edge-type rules',
      tags: []
    })
    const s = extractThoughtSignals(t)
    expect(s.dependencyCue).toBeTrue()
  })

  test('blocked prefix yields dependencyCue=true', () => {
    const t = makeThought({
      content: 'blocked on the embedder fix',
      tags: []
    })
    const s = extractThoughtSignals(t)
    expect(s.dependencyCue).toBeTrue()
  })

  test('dependencyCue in pair signals picks up the target thought cue', () => {
    const src = makeThought({ id: 'src', content: 'see the note below' })
    const tgt = makeThought({
      id: 'tgt',
      content: 'Task #956 (tester) in review: do not trigger',
      tags: []
    })
    seedThought({ id: src.id, content: src.content })
    seedThought({ id: tgt.id, content: tgt.content })
    const sig = extractPairSignals(src, tgt)
    expect(sig.dependencyCue).toBeFalse()
  })

  test('dependencyCue in pair is true when target carries a `task` tag', () => {
    const src = makeThought({ id: 'src', content: 'depends on the next item' })
    const tgt = makeThought({
      id: 'tgt',
      content: 'some note',
      tags: [{ name: 'task', id: '' }]
    })
    seedThought({ id: src.id, content: src.content })
    seedThought({ id: tgt.id, content: tgt.content })
    const sig = extractPairSignals(src, tgt)
    expect(sig.dependencyCue).toBeTrue()
  })
})
