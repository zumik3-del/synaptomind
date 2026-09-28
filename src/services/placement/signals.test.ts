import { beforeEach, afterEach, expect, test, describe } from 'bun:test'
import { createTestDb } from '../../test/helpers'
import { closeDb } from '../../db'
import { seedThought, seedEdge } from '../../test/helpers'
import {
  extractPairSignals,
  extractThoughtSignals,
  type PairSignalDeps,
} from './signals'
import type { Thought } from '../../db/thoughts'
import type { Tag } from '../../db/tags'

beforeEach(createTestDb)
afterEach(closeDb)

type MakeThoughtInput = Omit<Partial<Thought>, 'tags'> & { tags?: string[] }

function makeThought(overrides?: MakeThoughtInput): Thought {
  const tagNames = overrides?.tags ?? []
  const tagsObj = tagNames.map((name: string) => ({ name, id: '' })) as unknown as Tag[]
  const { tags: _tags, ...rest } = overrides ?? {}
  return {
    id: 't-' + Math.random().toString(36).slice(2),
    content: 'test thought',
    status: 'active',
    tags: tagsObj,
    source: null,
    project_id: 'default',
    is_cluster: 0,
    is_profile: 0,
    is_protected: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    archived_at: null,
    surface_after: null,
    ...rest,
  } as Thought
}

function stubSearch(map: Record<string, { id: string; similarity: number }[]>): PairSignalDeps['searchNeighbors'] {
  return (_id, _emb, _k) => map[_id] ?? []
}

describe('extractThoughtSignals', () => {
  test('copies identity/status/project/createdAt verbatim', () => {
    const t = makeThought({ content: 'hello', status: 'draft', project_id: 'proj-1', created_at: '2024-01-01T00:00:00Z' })
    const s = extractThoughtSignals(t)
    expect(s.id).toBe(t.id)
    expect(s.status).toBe('draft')
    expect(s.projectId).toBe('proj-1')
    expect(s.createdAt).toBe('2024-01-01T00:00:00Z')
    expect(s.normalised).toBe('hello')
  })

  test('lowercases tags', () => {
    const t = makeThought({ tags: ['Foo', 'BAR'] })
    const s = extractThoughtSignals(t)
    expect(s.tags).toEqual(['foo', 'bar'])
  })

  test('detects negation markers', () => {
    const t = makeThought({ content: "I don't think this is not right" })
    const s = extractThoughtSignals(t)
    expect(s.negations).toContain("don't")
    expect(s.negations).toContain('not')
  })

  test('evidentialCue is true when evidence-like words appear', () => {
    const t = makeThought({ content: 'The data confirms the hypothesis' })
    const s = extractThoughtSignals(t)
    expect(s.evidentialCue).toBeTrue()
  })

  test('evolutionCue is true when change-like words appear', () => {
    const t = makeThought({ content: 'This was updated yesterday' })
    const s = extractThoughtSignals(t)
    expect(s.evolutionCue).toBeTrue()
  })

  test('dependencyCue is true via tag', () => {
    const t = makeThought({ tags: ['todo'] })
    const s = extractThoughtSignals(t)
    expect(s.dependencyCue).toBeTrue()
  })

  test('dependencyCue is true via content prefix', () => {
    const t = makeThought({ content: 'task: finish this later' })
    const s = extractThoughtSignals(t)
    expect(s.dependencyCue).toBeTrue()
  })

  test('dependencyCue is false when no cue present', () => {
    const t = makeThought({ content: 'This is a standalone note' })
    const s = extractThoughtSignals(t)
    expect(s.dependencyCue).toBeFalse()
  })
})

describe('extractPairSignals', () => {
  test('missing embedding => embeddingSimilarity=0 and no throw', () => {
    const src = makeThought({ id: 'src', content: 'hello world', created_at: '2024-01-02T00:00:00Z' })
    const tgt = makeThought({ id: 'tgt', content: 'hello universe', created_at: '2024-01-01T00:00:00Z' })
    seedThought({ id: src.id, content: src.content, created_at: src.created_at })
    seedThought({ id: tgt.id, content: tgt.content, created_at: tgt.created_at })
    const signals = extractPairSignals(src, tgt)
    expect(signals.embeddingSimilarity).toBe(0)
    expect(signals.lexicalOverlap).toBeGreaterThan(0)
  })

  test('embeddingSimilarity is honoured from options', () => {
    const src = makeThought({ id: 'src', content: 'a' })
    const tgt = makeThought({ id: 'tgt', content: 'b' })
    const signals = extractPairSignals(src, tgt, { embeddingSimilarity: 0.8 })
    expect(signals.embeddingSimilarity).toBeCloseTo(0.8, 5)
  })

  test('embeddingSimilarity via searchNeighbors stub hits', () => {
    const src = makeThought({ id: 'src', content: 'a' })
    const tgt = makeThought({ id: 'tgt', content: 'b' })
    const deps: PairSignalDeps = {
      searchNeighbors: stubSearch({ src: [{ id: 'tgt', similarity: 0.75 }] }),
    }
    const signals = extractPairSignals(src, tgt, { embedding: new Float32Array([1]) }, deps)
    expect(signals.embeddingSimilarity).toBeCloseTo(0.75, 5)
  })

  test('embeddingSimilarity via searchNeighbors returns 0 on miss', () => {
    const src = makeThought({ id: 'src', content: 'a' })
    const tgt = makeThought({ id: 'tgt', content: 'b' })
    const deps: PairSignalDeps = {
      searchNeighbors: stubSearch({ src: [{ id: 'other', similarity: 0.9 }] }),
    }
    const signals = extractPairSignals(src, tgt, { embedding: new Float32Array([1]) }, deps)
    expect(signals.embeddingSimilarity).toBe(0)
  })

  test('embeddingSimilarity via searchNeighbors is 0 when the fn throws', () => {
    const src = makeThought({ id: 'src', content: 'a' })
    const tgt = makeThought({ id: 'tgt', content: 'b' })
    const deps: PairSignalDeps = {
      searchNeighbors: () => { throw new Error('index down') },
    }
    const signals = extractPairSignals(src, tgt, { embedding: new Float32Array([1]) }, deps)
    expect(signals.embeddingSimilarity).toBe(0)
  })

  test('lexicalOverlap is computed from normalised content', () => {
    const src = makeThought({ id: 'src', content: 'a b c' })
    const tgt = makeThought({ id: 'tgt', content: 'b c d' })
    const signals = extractPairSignals(src, tgt)
    // {a,b,c} ∩ {b,c,d} = {b,c}, union = 4 → 0.5
    expect(signals.lexicalOverlap).toBeCloseTo(0.5, 5)
  })

  test('negationDelta is 0 when both or neither side is negated', () => {
    const neg = makeThought({ content: "I don't like it" })
    const pos = makeThought({ content: 'I like it' })
    expect(extractPairSignals(neg, neg).negationDelta).toBe(0)
    expect(extractPairSignals(pos, pos).negationDelta).toBe(0)
    expect(extractPairSignals(neg, pos).negationDelta).toBe(1)
    expect(extractPairSignals(pos, neg).negationDelta).toBe(1)
  })

  test('temporalOrder reflects creation order', () => {
    const older = makeThought({ id: 'older', created_at: '2020-01-01T00:00:00Z' })
    const newer = makeThought({ id: 'newer', created_at: '2024-01-01T00:00:00Z' })
    expect(extractPairSignals(newer, older).temporalOrder).toBe('newer')
    expect(extractPairSignals(older, newer).temporalOrder).toBe('older')
    expect(extractPairSignals(newer, newer).temporalOrder).toBe('same')
  })

  test('tagOverlap is set Jaccard', () => {
    const a = makeThought({ id: 'a', tags: ['x', 'y'] })
    const b = makeThought({ id: 'b', tags: ['y', 'z'] })
    const sig = extractPairSignals(a, b)
    // {x,y} ∩ {y,z} = {y}, union = 3 → 1/3
    expect(sig.tagOverlap).toBeCloseTo(1 / 3, 5)
  })

  test('tagOverlap is 0 when either side has no tags', () => {
    const a = makeThought({ id: 'a', tags: ['x'] })
    const b = makeThought({ id: 'b', tags: [] })
    expect(extractPairSignals(a, b).tagOverlap).toBe(0)
  })

  test('dependencyCue picks up from the target thought', () => {
    const src = makeThought({ id: 'src', content: 'see below' })
    const tgt = makeThought({ id: 'tgt', content: 'pending: do this', tags: [] })
    expect(extractPairSignals(src, tgt).dependencyCue).toBeTrue()
  })

  test('existingEdgeType reflects the edge in the DB', () => {
    const srcId = seedThought({ id: 'src', content: 'a' })
    const tgtId = seedThought({ id: 'tgt', content: 'b' })
    seedEdge(srcId, tgtId, 'supports')
    const src = makeThought({ id: srcId, content: 'a' })
    const tgt = makeThought({ id: tgtId, content: 'b' })
    expect(extractPairSignals(src, tgt).existingEdgeType).toBe('supports')
  })

  test('existingEdgeType is null when no edge exists', () => {
    const src = makeThought({ id: 'src', content: 'a' })
    const tgt = makeThought({ id: 'tgt', content: 'b' })
    expect(extractPairSignals(src, tgt).existingEdgeType).toBeNull()
  })

  test('sameProject is true when projects match', () => {
    const a = makeThought({ id: 'a', project_id: 'p' })
    const b = makeThought({ id: 'b', project_id: 'p' })
    expect(extractPairSignals(a, b).sameProject).toBeTrue()
  })

  test('sameProject is false when projects differ', () => {
    const a = makeThought({ id: 'a', project_id: 'p1' })
    const b = makeThought({ id: 'b', project_id: 'p2' })
    expect(extractPairSignals(a, b).sameProject).toBeFalse()
  })

  test('standing defaults to current in a fresh :memory: DB', () => {
    const src = makeThought({ id: 'src', content: 'a' })
    const tgt = makeThought({ id: 'tgt', content: 'b' })
    const sig = extractPairSignals(src, tgt)
    expect(sig.sourceStanding).toBe('current')
    expect(sig.targetStanding).toBe('current')
  })
})
