import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { closeDb } from '../db/init'
import { createTestDb, seedThought } from '../test/helpers'
import { searchThoughts, searchThoughtsOutcome } from './search.service'

/**
 * Task #2178, service layer: an id-shaped query is an id lookup.
 *
 * The DB layer (`src/db/search-id.test.ts`) pins the recognition rules and the
 * lookup itself. This file pins what the *service* must do around it:
 *
 * - the addressed thought comes back in any status, ignoring every scope
 *   filter (`status`, `project`, `tag`, `is_cluster`, `min_importance`),
 * - an unknown id returns no rows at all — never a best-effort semantic
 *   neighbour — with `reason: 'id_not_found'`,
 * - the embedder is never called for an id-shaped query,
 * - the calibrated relevance gate never touches an id result.
 *
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

  test('an id result carries match_source [id], no similarity and low_confidence false', async () => {
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

  test('is_cluster / clusterFilter is ignored', async () => {
    seedThought({ id: A, content: 'CLUSTER_ID marker', is_cluster: 1 })

    const outcome = await searchThoughtsOutcome({ query: A, clusterFilter: 'exclude' })

    expect(outcome.items.map(r => r.thought.id)).toEqual([A])
  })

  test('a superseded thought is still returned by its id (standing is not consulted)', async () => {
    const oldId = seedThought({ id: A, content: 'SUPERSEDED_ID marker' })
    const newId = seedThought({ id: B, content: 'SUPERSEDING_ID marker' })
    const { createEdge } = await import('../db/edges')
    const { getDb } = await import('../db/container')
    createEdge(getDb(), newId, oldId, 'replaces')

    const outcome = await searchThoughtsOutcome({ query: A, supersessionMode: 'suppress' })

    expect(outcome.items.map(r => r.thought.id)).toEqual([oldId])
  })

  test('an unknown id returns no rows with reason id_not_found', async () => {
    seedThought({ id: A, content: 'NEIGHBOUR_ID marker' })

    const outcome = await searchThoughtsOutcome({ query: '018f0a00-0000-7000-8000-0000000000ff' })

    expect(outcome.items).toEqual([])
    expect(outcome.matched).toBe(0)
    expect(outcome.filtered_out).toBe(0)
    expect(outcome.reason).toBe('id_not_found')
  })

  test('an ambiguous prefix returns every match ordered by id and flags it', async () => {
    seedThought({ id: B, content: 'AMBIGUOUS_ID beta' })
    seedThought({ id: A, content: 'AMBIGUOUS_ID alpha' })

    const outcome = await searchThoughtsOutcome({ query: '018f0a00' })

    expect(outcome.items.map(r => r.thought.id)).toEqual([A, B])
    expect(outcome.matched).toBe(2)
    expect(outcome.ambiguous).toBe(true)
  })

  test('a mixed-case prefix with a dash resolves the same rows', async () => {
    seedThought({ id: A, content: 'PREFIX_ID alpha' })

    const outcome = await searchThoughtsOutcome({ query: '018F0A00-00' })

    expect(outcome.items.map(r => r.thought.id)).toEqual([A])
    expect(outcome.ambiguous).toBeUndefined()
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

    // Positive control: the mock is in force and counts a real search.
    await searchThoughtsOutcome({ query: 'ordinary words that are not an id', topK: 5 })
    const callsAfterWordQuery = embeddingCalls
    expect(callsAfterWordQuery).toBeGreaterThan(0)

    // Reset, then prove the id path adds no call at all.
    embeddingCalls = 0
    await searchThoughtsOutcome({ query: A })
    expect(embeddingCalls).toBe(0)
  })

  test('a hex string shorter than 8 characters is a word query, not an id lookup', async () => {
    seedThought({ id: A, content: 'SHORT_HEX_ID marker' })

    const outcome = await searchThoughtsOutcome({ query: '018f0a0', topK: 5 })

    // Fell through to the normal search: no id_not_found reason, and the
    // embedder was consulted.
    expect(outcome.reason).toBeUndefined()
    expect(embeddingCalls).toBeGreaterThan(0)
  })
})
