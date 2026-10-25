import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { getDb } from './container'
import { closeDb } from './init'
import { findThoughtsByIdQuery, parseThoughtIdQuery } from './search-id'

/**
 * Task #2178: an id-shaped search query resolves to exactly the addressed
 * thought(s), in any status, without touching the embedding/BM25 legs.
 *
 * Here the DB layer is pinned directly: the recognition rules
 * (`parseThoughtIdQuery`) and the GLOB/`=` lookup (`findThoughtsByIdQuery`).
 * The service-level behaviour (filters ignored, no embedder call) lives in
 * `src/services/search.service.id-lookup.test.ts`; the HTTP surface in
 * `src/api/thoughts-search.id-lookup.test.ts`.
 *
 * All ids are fixed so ordering and prefix ambiguity are deterministic; the
 * `:memory:` DB is enough — the vector leg is never reached on this path.
 */

/** Shares the 13-hex prefix `018f0a00-0000-7` with {@link B} — an ambiguous prefix. */
const A = '018f0a00-0000-7000-8000-00000000000a'
/** Shares the 13-hex prefix `018f0a00-0000-7` with {@link A}. */
const B = '018f0a00-0000-7000-8000-00000000000b'
/** A prefix of its own (`018f0b00-0000-7`). */
const C = '018f0b00-0000-7000-8000-00000000000c'

beforeEach(createTestDb)
afterEach(closeDb)

describe('parseThoughtIdQuery — what counts as an id', () => {
  test('a full canonical UUID is an exact id', () => {
    expect(parseThoughtIdQuery(A)).toEqual({ pattern: A, exact: true })
  })

  test('an uppercase and dashed UUID resolves to the stored lowercase form', () => {
    expect(parseThoughtIdQuery(A.toUpperCase())).toEqual({ pattern: A, exact: true })
  })

  test('surrounding whitespace is trimmed before recognition', () => {
    expect(parseThoughtIdQuery(`\t  ${A.toUpperCase()}  \n`)).toEqual({ pattern: A, exact: true })
  })

  test('a 13-character hex prefix is a prefix query, not an exact one (task #2186 floor)', () => {
    expect(parseThoughtIdQuery('018f0a0000007')).toEqual({ pattern: '018f0a00-0000-7*', exact: false })
  })

  test('a 12-character hex string is a word, not an id (the floor is 13)', () => {
    expect(parseThoughtIdQuery('018f0a000000')).toBeNull()
  })

  test('a 7-character hex string is a word, not an id', () => {
    expect(parseThoughtIdQuery('018f0a0')).toBeNull()
  })

  test('more than 32 hex characters is a word, not an id', () => {
    expect(parseThoughtIdQuery('018f0a00000070008000000000000000a')).toBeNull()
  })

  test('hyphen placement is normalised, so a dashed prefix addresses the same row', () => {
    // `018f0a00-0000-7` → hex `018f0a0000007` → canonical `018f0a00-0000-7` + GLOB star.
    expect(parseThoughtIdQuery('018f0a00-0000-7')).toEqual({ pattern: '018f0a00-0000-7*', exact: false })
    expect(parseThoughtIdQuery('018f0a0000007')).toEqual({ pattern: '018f0a00-0000-7*', exact: false })
  })

  test('a non-hex query is a word', () => {
    expect(parseThoughtIdQuery('search')).toBeNull()
    expect(parseThoughtIdQuery('hello world')).toBeNull()
    expect(parseThoughtIdQuery('018f0a00x')).toBeNull()
  })

  test('an empty or blank query is not an id', () => {
    expect(parseThoughtIdQuery('')).toBeNull()
    expect(parseThoughtIdQuery('   ')).toBeNull()
  })

  test('a hex-looking word below the 13-character floor is a word (task #2186)', () => {
    // The rule is positional: `deadbeef` (8 hex) is below the floor, so it keeps
    // flowing through the normal search instead of becoming an id miss. A longer
    // hex word (>= 13) is still positional and falls back at the service layer
    // when the id lookup misses.
    expect(parseThoughtIdQuery('deadbeef')).toBeNull()
    expect(parseThoughtIdQuery('20251025')).toBeNull()
    expect(parseThoughtIdQuery('deadbeefdeadbeef')).toEqual({ pattern: 'deadbeef-dead-beef*', exact: false })
  })
})

describe('findThoughtsByIdQuery — resolving the id against the stored rows', () => {
  test('a non-id-shaped query is not an id lookup at all', () => {
    seedThought({ id: A, content: 'alpha' })
    expect(findThoughtsByIdQuery(getDbOrThrow(), 'alpha')).toBeNull()
  })

  test('a full UUID returns exactly that thought, in the `id` match_source shape', () => {
    seedThought({ id: A, content: 'alpha' })
    seedThought({ id: C, content: 'gamma' })

    const results = findThoughtsByIdQuery(getDbOrThrow(), A)

    expect(results).not.toBeNull()
    expect(results).toHaveLength(1)
    const [hit] = results!
    expect(hit.thought.id).toBe(A)
    expect(hit.thought.content).toBe('alpha')
    expect(hit.match_source).toEqual(['id'])
    expect(hit.low_confidence).toBe(false)
    // No cosine signal: an id is not a similarity hit.
    expect(hit.similarity).toBeUndefined()
    expect(hit.distance).toBeUndefined()
    expect(hit.relevance).toBeUndefined()
  })

  test('an uppercase/dashed UUID resolves the same row', () => {
    seedThought({ id: A, content: 'alpha' })

    const results = findThoughtsByIdQuery(getDbOrThrow(), A.toUpperCase())

    expect(results?.map(r => r.thought.id)).toEqual([A])
  })

  test('status is ignored: an archived thought is returned by its id', () => {
    seedThought({ id: A, content: 'alpha', status: 'archived' })

    const results = findThoughtsByIdQuery(getDbOrThrow(), A)

    expect(results?.map(r => r.thought.id)).toEqual([A])
    expect(results?.[0].thought.status).toBe('archived')
  })

  test('a draft thought is returned by its id', () => {
    seedThought({ id: B, content: 'beta', status: 'draft' })

    expect(findThoughtsByIdQuery(getDbOrThrow(), B)?.map(r => r.thought.id)).toEqual([B])
  })

  test('an unknown full UUID returns no rows (never other rows)', () => {
    seedThought({ id: A, content: 'alpha' })

    expect(findThoughtsByIdQuery(getDbOrThrow(), '018f0a00-0000-7000-8000-0000000000ff')).toEqual([])
  })

  test('an unknown 13-hex prefix returns no rows', () => {
    seedThought({ id: A, content: 'alpha' })

    expect(findThoughtsByIdQuery(getDbOrThrow(), '9999999900000')).toEqual([])
  })

  test('an ambiguous prefix returns every match, ordered by id', () => {
    seedThought({ id: B, content: 'beta' })
    seedThought({ id: A, content: 'alpha' })
    seedThought({ id: C, content: 'gamma' })

    const results = findThoughtsByIdQuery(getDbOrThrow(), '018f0a0000007')

    expect(results?.map(r => r.thought.id)).toEqual([A, B])
  })

  test('a prefix matching one thought returns only it', () => {
    seedThought({ id: A, content: 'alpha' })
    seedThought({ id: C, content: 'gamma' })

    expect(findThoughtsByIdQuery(getDbOrThrow(), '018f0b0000007')?.map(r => r.thought.id)).toEqual([C])
  })

  test('an id result carries the thought tags', () => {
    seedThought({ id: A, content: 'alpha', tags: JSON.stringify(['keepme']) })

    const results = findThoughtsByIdQuery(getDbOrThrow(), A)

    expect(results?.[0].thought.tags?.map(t => t.name)).toEqual(['keepme'])
  })
})

/** The active test DB (`:memory:` from `beforeEach(createTestDb)`). */
function getDbOrThrow() {
  return getDb()
}
