import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { ID_PREFIX_MATCH_HARD_CAP } from '../db/search-id'
import { getDb } from '../context/container'
import { closeDb } from '../db/init'
import { createTestDb, seedThought } from '../test/helpers'
import { searchThoughts, searchThoughtsOutcome } from './search.service'

/*
 * The embedder mock both keeps the suite offline and counts invocations: each
 * "no embedder call" assertion is paired with a positive control in the same
 * test, so a mock that is not actually in force fails loudly instead of making
 * the zero-call assertion pass vacuously.
 */

let embeddingCalls = 0

mock.module('../embedder/client', () => ({
  generateEmbedding: async () => {
    embeddingCalls += 1
    return new Float32Array(384)
  },
  generateEmbeddings: async () => {
    embeddingCalls += 1
    return [new Float32Array(384)]
  },
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

const A = '018f0a00-0000-7000-8000-00000000000a'
const B = '018f0a00-0000-7000-8000-00000000000b'

beforeEach(() => {
  createTestDb()
  embeddingCalls = 0
})
afterEach(closeDb)

describe('searchThoughtsOutcome — id lookup', () => {
  test('a full UUID resolves to exactly that thought', async () => {
    seedThought({ id: A, content: 'ALPHA_ID marker', status: 'active' })
    seedThought({ id: B, content: 'BETA_ID marker', status: 'active' })

    const outcome = await searchThoughtsOutcome({ query: A, topK: 10 })

    expect(outcome.items.map(r => r.thought.id)).toEqual([A])
    expect(outcome.matched).toBe(1)
    expect(outcome.filtered_out).toBe(0)
    expect(outcome.reason).toBeUndefined()
    expect(outcome.ambiguous).toBeUndefined()
  })

  test('an id result carries match_source [id], no similarity and low_confidence false for a current hit', async () => {
    seedThought({ id: A, content: 'ALPHA_ID marker' })

    const [hit] = (await searchThoughtsOutcome({ query: A })).items

    expect(hit.match_source).toEqual(['id'])
    expect(hit.similarity).toBeUndefined()
    expect(hit.distance).toBeUndefined()
    expect(hit.relevance).toBeUndefined()
    expect(hit.low_confidence).toBe(false)
  })

  test('status is ignored: a draft thought resolves even with the HTTP default status=active', async () => {
    seedThought({ id: A, content: 'DRAFT_ID marker', status: 'draft' })

    const outcome = await searchThoughtsOutcome({ query: A, statusFilter: 'active' })

    expect(outcome.items.map(r => r.thought.id)).toEqual([A])
    expect(outcome.items[0].thought.status).toBe('draft')
  })

  test('status is ignored for an archived thought', async () => {
    seedThought({ id: A, content: 'ARCHIVED_ID marker', status: 'archived' })

    const outcome = await searchThoughtsOutcome({ query: A, statusFilter: 'active' })

    expect(outcome.items.map(r => r.thought.id)).toEqual([A])
  })

  test('the project filter is ignored', async () => {
    seedThought({ id: A, content: 'PROJECT_ID marker', project_id: 'proj-b' })

    const outcome = await searchThoughtsOutcome({ query: A, projectFilter: 'proj-a' })

    expect(outcome.items.map(r => r.thought.id)).toEqual([A])
  })

  test('the tag filter is ignored', async () => {
    seedThought({ id: A, content: 'TAG_ID marker' })

    const outcome = await searchThoughtsOutcome({ query: A, tagFilter: 'not-on-this-thought' })

    expect(outcome.items.map(r => r.thought.id)).toEqual([A])
  })

  test('min_importance is ignored', async () => {
    seedThought({ id: A, content: 'IMPORTANCE_ID marker', importance: 0.05 })

    const outcome = await searchThoughtsOutcome({ query: A, minImportance: 1 })

    expect(outcome.items.map(r => r.thought.id)).toEqual([A])
  })

  test('clusterFilter applies to a full UUID: a cluster row is filtered out of a non-cluster request (task #2190)', async () => {
    seedThought({ id: A, content: 'CLUSTER_ID marker', is_cluster: 1 })

    const excluded = await searchThoughtsOutcome({ query: A, clusterFilter: 'exclude' })

    expect(excluded.items).toEqual([])

    const only = await searchThoughtsOutcome({ query: A, clusterFilter: 'only' })

    expect(only.items.map(r => r.thought.id)).toEqual([A])
  })

  test('clusterFilter applies to a prefix too', async () => {
    seedThought({ id: A, content: 'PLAIN_PREFIX_ROW', is_cluster: 0 })
    seedThought({ id: B, content: 'CLUSTER_PREFIX_ROW', is_cluster: 1 })

    const outcome = await searchThoughtsOutcome({ query: '018f0a0000007', clusterFilter: 'only' })

    expect(outcome.items.map(r => r.thought.id)).toEqual([B])
  })

  test('a prefix is scoped by project: a predictable timestamp key cannot read another project (task #2190)', async () => {
    seedThought({ id: A, content: 'PREFIX_PROJ_A', project_id: 'proj-a' })
    seedThought({ id: B, content: 'PREFIX_PROJ_B', project_id: 'proj-b' })

    const scoped = await searchThoughtsOutcome({ query: '018f0a0000007', projectFilter: 'proj-a' })

    expect(scoped.items.map(r => r.thought.id)).toEqual([A])
  })

  test('a prefix seeded in two projects is ambiguous unfiltered and scope-narrows to one project (task #2192)', async () => {
    seedThought({ id: A, content: 'SHARED_PREFIX_PROJECT_A', project_id: 'proj-a' })
    seedThought({ id: B, content: 'SHARED_PREFIX_PROJECT_B', project_id: 'proj-b' })

    const unscoped = await searchThoughtsOutcome({ query: '018f0a0000007' })

    expect(unscoped.items.map(r => r.thought.id)).toEqual([A, B])
    expect(unscoped.matched).toBe(2)
    expect(unscoped.ambiguous).toBe(true)

    const scoped = await searchThoughtsOutcome({ query: '018f0a0000007', projectFilter: 'proj-a' })

    expect(scoped.items.map(r => r.thought.id)).toEqual([A])
    expect(scoped.matched).toBe(1)
    expect(scoped.ambiguous).toBeUndefined()
  })

  test('the explicit-reference rule: a full UUID resolves across projects while its own prefix does not (task #2192)', async () => {
    seedThought({ id: A, content: 'CROSS_PROJECT_REFERENCE', project_id: 'proj-b' })

    const byUuid = await searchThoughtsOutcome({ query: A, projectFilter: 'proj-a' })

    expect(byUuid.items.map(r => r.thought.id)).toEqual([A])

    const byPrefix = await searchThoughtsOutcome({
      query: '018f0a0000007',
      projectFilter: 'proj-a'
    })

    expect(byPrefix.items).toEqual([])
    expect(byPrefix.warnings?.[0]).toContain('id_not_found')
  })

  test('a prefix that matches only outside the project falls back to the word search with an id_not_found note (task #2190)', async () => {
    seedThought({ id: B, content: 'PREFIX_OUT_OF_SCOPE', project_id: 'proj-b' })

    const outcome = await searchThoughtsOutcome({ query: '018f0a0000007', projectFilter: 'proj-a' })

    expect(outcome.items).toEqual([])
    expect(outcome.warnings?.[0]).toContain('id_not_found')
    expect(outcome.reason).toBe('id_not_found')
  })

  test('a prefix is scoped by status', async () => {
    seedThought({ id: A, content: 'PREFIX_ACTIVE', status: 'active' })
    seedThought({ id: B, content: 'PREFIX_ARCHIVED', status: 'archived' })

    const outcome = await searchThoughtsOutcome({ query: '018f0a0000007', statusFilter: 'active' })

    expect(outcome.items.map(r => r.thought.id)).toEqual([A])
  })

  describe('a prefix is a scope query, a full UUID an explicit reference (task #2532)', () => {
    const PREFIX = '018f0a0000007'
    const OWN = '018f0a00-0000-7000-8000-0000000000a1'
    const OWN_FAINT = '018f0a00-0000-7000-8000-0000000000a2'
    const FOREIGN = '018f0a00-0000-7000-8000-0000000000b1'
    const ARCHIVED = '018f0a00-0000-7000-8000-0000000000c1'

    // `seedThought({ importance })` is swallowed by `trg_thought_importance_insert`, so importance
    // is written after the row exists.
    function seedScopeWorld(): void {
      const db = getDb()
      const setImportance = (id: string, importance: number) =>
        db
          .prepare(`UPDATE thought_importance SET importance = ? WHERE thought_id = ?`)
          .run(importance, id)
      seedThought({
        id: OWN,
        content: 'SCOPE_TAGGED_OWN',
        project_id: 'proj-a',
        status: 'active',
        tags: '["beta"]'
      })
      seedThought({
        id: OWN_FAINT,
        content: 'SCOPE_TAGGED_FAINT',
        project_id: 'proj-a',
        status: 'active',
        tags: '["beta"]'
      })
      seedThought({
        id: FOREIGN,
        content: 'SCOPE_TAGGED_FOREIGN',
        project_id: 'proj-b',
        status: 'active',
        tags: '["beta"]'
      })
      seedThought({
        id: ARCHIVED,
        content: 'SCOPE_OTHER_TAG_ARCHIVED',
        project_id: 'proj-a',
        status: 'archived',
        tags: '["gamma"]'
      })
      setImportance(OWN, 0.9)
      setImportance(FOREIGN, 0.9)
      setImportance(ARCHIVED, 0.9)
      setImportance(OWN_FAINT, 0.1)
    }

    test('a prefix honours tag', async () => {
      seedScopeWorld()

      const outcome = await searchThoughtsOutcome({ query: PREFIX, tagFilter: 'beta' })

      expect(outcome.items.map(r => r.thought.id)).toEqual([OWN, OWN_FAINT, FOREIGN])
    })

    test('a prefix honours min_importance', async () => {
      seedScopeWorld()

      const outcome = await searchThoughtsOutcome({ query: PREFIX, minImportance: 0.5 })

      expect(outcome.items.map(r => r.thought.id)).toEqual([OWN, FOREIGN, ARCHIVED])
    })

    test('a prefix takes status, project, tag and min_importance together', async () => {
      seedScopeWorld()

      const outcome = await searchThoughtsOutcome({
        query: PREFIX,
        tagFilter: 'beta',
        projectFilter: 'proj-a',
        statusFilter: 'active',
        minImportance: 0.5
      })

      expect(outcome.items.map(r => r.thought.id)).toEqual([OWN])
    })

    test('a full UUID still ignores all four: the explicit reference answers', async () => {
      seedScopeWorld()

      const outcome = await searchThoughtsOutcome({
        query: ARCHIVED,
        tagFilter: 'beta',
        projectFilter: 'proj-b',
        statusFilter: 'active',
        minImportance: 1
      })

      expect(outcome.items.map(r => r.thought.id)).toEqual([ARCHIVED])
    })
  })

  test('a superseded thought is still answered by its id, flagged not suppressed (task #2186)', async () => {
    const oldId = seedThought({ id: A, content: 'SUPERSEDED_ID marker' })
    const newId = seedThought({ id: B, content: 'SUPERSEDING_ID marker' })
    const { createEdge } = await import('../db/edges')
    const { getDb } = await import('../context/container')
    createEdge(getDb(), newId, oldId, 'replaces')

    const outcome = await searchThoughtsOutcome({ query: A, supersessionMode: 'suppress' })

    expect(outcome.items.map(r => r.thought.id)).toEqual([oldId])
    expect(outcome.items[0].standing).toBe('superseded')
    expect(outcome.items[0].superseded_by).toEqual([newId])
    expect(outcome.items[0].low_confidence).toBe(false)
  })

  test('an id-shaped miss falls back to the word search and reports id_not_found as a warning (task #2186)', async () => {
    const id = seedThought({ id: A, content: 'release 2025102512345 shipped the fix' })

    const outcome = await searchThoughtsOutcome({ query: '2025102512345', topK: 10 })

    expect(outcome.items.map(r => r.thought.id)).toEqual([id])
    expect(outcome.matched).toBeGreaterThan(0)
    expect(outcome.warnings?.[0]).toContain('id_not_found')
    expect(outcome.reason).toBeUndefined()
  })

  test('an unknown full UUID keeps its precise reason when the fallback finds nothing either (task #2186)', async () => {
    seedThought({ id: A, content: 'NEIGHBOUR_ID marker' })

    const outcome = await searchThoughtsOutcome({ query: '018f0a00-0000-7000-8000-0000000000ff' })

    expect(outcome.items).toEqual([])
    expect(outcome.matched).toBe(0)
    expect(outcome.filtered_out).toBe(0)
    expect(outcome.warnings?.[0]).toContain('id_not_found')
    expect(outcome.reason).toBe('id_not_found')
  })

  test('an ambiguous prefix returns every match ordered by id and flags it', async () => {
    seedThought({ id: B, content: 'AMBIGUOUS_ID beta' })
    seedThought({ id: A, content: 'AMBIGUOUS_ID alpha' })

    const outcome = await searchThoughtsOutcome({ query: '018f0a0000007' })

    expect(outcome.items.map(r => r.thought.id)).toEqual([A, B])
    expect(outcome.matched).toBe(2)
    expect(outcome.ambiguous).toBe(true)
  })

  test('a mixed-case prefix with a dash resolves the same rows', async () => {
    seedThought({ id: A, content: 'PREFIX_ID alpha' })

    const outcome = await searchThoughtsOutcome({ query: '018F0A00-0000-7' })

    expect(outcome.items.map(r => r.thought.id)).toEqual([A])
    expect(outcome.ambiguous).toBeUndefined()
  })

  test('a sub-floor hex word (20251025) is an ordinary search that still finds its thought (task #2186)', async () => {
    const id = seedThought({ id: A, content: 'released 20251025 with the fix' })
    seedThought({ id: B, content: 'UNRELATED_BYSTANDER marker' })

    const outcome = await searchThoughtsOutcome({ query: '20251025', topK: 10 })

    expect(outcome.items.map(r => r.thought.id)).toEqual([id])
    expect(outcome.items[0].match_source).toContain('bm25')
    expect(outcome.warnings).toBeUndefined()
    expect(outcome.reason).toBeUndefined()
  })

  test('a same-millisecond prefix batch is capped at the hard cap and still reported ambiguous (task #2186)', async () => {
    const total = ID_PREFIX_MATCH_HARD_CAP + 50
    for (let i = 0; i < total; i++) {
      seedThought({
        id: `018f0d00-0000-7000-8000-${String(i).padStart(12, '0')}`,
        content: `BATCH_ROW_${i}`
      })
    }

    const hardCapped = await searchThoughtsOutcome({ query: '018f0d0000007', topK: 1000 })

    expect(ID_PREFIX_MATCH_HARD_CAP).toBe(100)
    expect(hardCapped.items).toHaveLength(ID_PREFIX_MATCH_HARD_CAP)
    expect(hardCapped.matched).toBe(ID_PREFIX_MATCH_HARD_CAP)
    expect(hardCapped.ambiguous).toBe(true)

    const limited = await searchThoughtsOutcome({ query: '018f0d0000007', topK: 5 })

    expect(limited.items).toHaveLength(5)
    expect(limited.ambiguous).toBe(true)
  })

  test('the array-returning searchThoughts returns the id row too (source compatibility)', async () => {
    seedThought({ id: A, content: 'COMPAT_ID marker' })

    const results = await searchThoughts({ query: A.toUpperCase(), topK: 5 })

    expect(results.map(r => r.thought.id)).toEqual([A])
    expect(results[0].match_source).toEqual(['id'])
  })
})

describe('searchThoughtsOutcome — embedder is never called for an id-shaped query', () => {
  test('an id lookup does not embed, while a word query does (positive control)', async () => {
    seedThought({ id: A, content: 'NO_EMBED_ID marker' })

    await searchThoughtsOutcome({ query: 'ordinary words that are not an id', topK: 5 })
    const callsAfterWordQuery = embeddingCalls
    expect(callsAfterWordQuery).toBeGreaterThan(0)

    embeddingCalls = 0
    await searchThoughtsOutcome({ query: A })
    expect(embeddingCalls).toBe(0)
  })

  test('a hex string shorter than the 13-character floor is a word query, not an id lookup', async () => {
    seedThought({ id: A, content: 'SHORT_HEX_ID marker' })

    const outcome = await searchThoughtsOutcome({ query: '018f0a000000', topK: 5 })

    expect(outcome.reason).toBeUndefined()
    expect(embeddingCalls).toBeGreaterThan(0)
  })
})
