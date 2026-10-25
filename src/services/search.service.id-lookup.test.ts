import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { ID_PREFIX_MATCH_HARD_CAP } from '../db/search-id'
import { closeDb } from '../db/init'
import { createTestDb, seedThought } from '../test/helpers'
import { searchThoughts, searchThoughtsOutcome } from './search.service'

/**
 * Task #2178, service layer: an id-shaped query is an id lookup (task #2186
 * revised the fallback, the prefix floor and the standing annotation).
 *
 * The DB layer (`src/db/search-id.test.ts`) pins the recognition rules and the
 * lookup itself. This file pins what the *service* must do around it:
 *
 * - the addressed thought comes back in any status, ignoring every scope
 *   filter (`status`, `project`, `tag`, `is_cluster`, `min_importance`),
 * - an id-shaped query that addresses nothing falls back to the normal search
 *   and only leaves an `id_not_found` warning — it never zeroes the answer,
 * - an addressed thought is annotated like any other hit (standing,
 *   superseded_by/contradicted_by, low_confidence when contested) but never
 *   suppressed by the lookup,
 * - the embedder is never called for an id-shaped query that *matches*,
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

  test('is_cluster / clusterFilter is ignored', async () => {
    seedThought({ id: A, content: 'CLUSTER_ID marker', is_cluster: 1 })

    const outcome = await searchThoughtsOutcome({ query: A, clusterFilter: 'exclude' })

    expect(outcome.items.map(r => r.thought.id)).toEqual([A])
  })

  test('a superseded thought is still answered by its id, flagged not suppressed (task #2186)', async () => {
    const oldId = seedThought({ id: A, content: 'SUPERSEDED_ID marker' })
    const newId = seedThought({ id: B, content: 'SUPERSEDING_ID marker' })
    const { createEdge } = await import('../db/edges')
    const { getDb } = await import('../db/container')
    createEdge(getDb(), newId, oldId, 'replaces')

    const outcome = await searchThoughtsOutcome({ query: A, supersessionMode: 'suppress' })

    // The explicit id always answers; the standing annotation replaces the
    // suppression the caller asked for, so a contested hit never looks clean.
    expect(outcome.items.map(r => r.thought.id)).toEqual([oldId])
    expect(outcome.items[0].standing).toBe('superseded')
    expect(outcome.items[0].superseded_by).toEqual([newId])
    expect(outcome.items[0].low_confidence).toBe(true)
  })

  test('an id-shaped miss falls back to the word search and reports id_not_found as a warning (task #2186)', async () => {
    // The token is 13 hex characters, so it *is* id-shaped; the corpus carries
    // it as text. Before #2186 this query returned zero rows.
    const id = seedThought({ id: A, content: 'release 2025102512345 shipped the fix' })

    const outcome = await searchThoughtsOutcome({ query: '2025102512345', topK: 10 })

    expect(outcome.items.map(r => r.thought.id)).toEqual([id])
    expect(outcome.matched).toBeGreaterThan(0)
    expect(outcome.warnings?.[0]).toContain('id_not_found')
    // Rows did come back, so no `reason` is needed to explain an empty answer.
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
    // Eight hex characters sit below the 13-character id floor, so the token is
    // a *word*: it must reach the lexical/semantic legs instead of being
    // turned into an id lookup that answers nothing.
    const id = seedThought({ id: A, content: 'released 20251025 with the fix' })
    seedThought({ id: B, content: 'UNRELATED_BYSTANDER marker' })

    const outcome = await searchThoughtsOutcome({ query: '20251025', topK: 10 })

    expect(outcome.items.map(r => r.thought.id)).toEqual([id])
    expect(outcome.items[0].match_source).toContain('bm25')
    // No id machinery ran: neither the note nor the miss reason mentions an id.
    expect(outcome.warnings).toBeUndefined()
    expect(outcome.reason).toBeUndefined()
  })

  test('a same-millisecond prefix batch is capped at the hard cap and still reported ambiguous (task #2186)', async () => {
    // A UUIDv7 bulk batch shares its first 12 hex characters, so a 13-hex
    // prefix can address the whole batch. Both the lookup and the service must
    // refuse to flood the answer, while still saying the prefix was ambiguous.
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

    // The caller's own limit still caps it further.
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

    // Positive control: the mock is in force and counts a real search.
    await searchThoughtsOutcome({ query: 'ordinary words that are not an id', topK: 5 })
    const callsAfterWordQuery = embeddingCalls
    expect(callsAfterWordQuery).toBeGreaterThan(0)

    // Reset, then prove the id path adds no call at all.
    embeddingCalls = 0
    await searchThoughtsOutcome({ query: A })
    expect(embeddingCalls).toBe(0)
  })

  test('a hex string shorter than the 13-character floor is a word query, not an id lookup', async () => {
    seedThought({ id: A, content: 'SHORT_HEX_ID marker' })

    const outcome = await searchThoughtsOutcome({ query: '018f0a000000', topK: 5 })

    // Fell through to the normal search: no id_not_found reason, and the
    // embedder was consulted.
    expect(outcome.reason).toBeUndefined()
    expect(embeddingCalls).toBeGreaterThan(0)
  })
})
