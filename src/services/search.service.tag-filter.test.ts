import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { getDb } from '../context/container'
import { closeDb } from '../db/init'
import { getThoughtTags, setThoughtTags } from '../db/tags'
import { createThought } from '../db/thoughts'
import { createTestDb, isVecExtensionAvailable, seedThought, withVecDb } from '../test/helpers'
import { searchThoughtsOutcome } from './search.service'

mock.module('../embedder/client', () => ({
  generateEmbedding: async () => new Float32Array(384),
  generateEmbeddings: async () => [new Float32Array(384)],
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

const DIM = 384
const VEC_AVAILABLE = isVecExtensionAvailable()

beforeEach(createTestDb)
afterEach(closeDb)

function itVec(name: string, fn: (db: Database) => void | Promise<void>): void {
  test.skipIf(!VEC_AVAILABLE)(name, () => withVecDb(fn))
}

function vectorAtCos(cos: number): Float32Array {
  const v = new Float32Array(DIM)
  v[0] = cos
  v[1] = Math.sqrt(Math.max(0, 1 - cos * cos))
  return v
}

// `new Float32Array(0)` is the documented BM25-only shape: the vector leg is skipped entirely, so
// these cases need neither vec0 nor a file-backed database.
const BM25_ONLY = new Float32Array(0)

describe('a tagged row outside the truncated candidate window is still answered', () => {
  const TOKEN = 'TAGSTARVE'
  const DISTRACTORS = 80
  const FILLER = Array.from({ length: 120 }, (_, i) => `fillerword${i}`).join(' ')

  // The tagged row is last on BOTH legs: farthest on the vector leg (cos 0.95 against 80 exact
  // matches) and worst on BM25 (one token in a 121-token document against 3-token distractors), so
  // every pre-fix window — the vector pool `topK*10`, the BM25 pool and the RRF slice — excludes it.
  function seedWorld(db: Database): string {
    for (let i = 0; i < DISTRACTORS; i++) {
      const id = seedThought({ content: `${TOKEN} note ${i}` })
      const vector = vectorAtCos(1)
      db.prepare(`INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, 'default')`).run(
        id,
        Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
      )
    }
    const tagged = seedThought({ content: `${TOKEN} ${FILLER}`, tags: '["needle"]' })
    const far = vectorAtCos(0.95)
    db.prepare(`INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, 'default')`).run(
      tagged,
      Buffer.from(far.buffer, far.byteOffset, far.byteLength)
    )
    return tagged
  }

  itVec(
    'hybrid: the tag filter reaches both legs, so the only tagged match is returned',
    async db => {
      const tagged = seedWorld(db)

      const unfiltered = await searchThoughtsOutcome(
        { query: TOKEN, embedding: vectorAtCos(1), topK: 3 },
        db
      )
      expect(unfiltered.items).toHaveLength(3)
      expect(unfiltered.items.map(r => r.thought.id)).not.toContain(tagged)

      const filtered = await searchThoughtsOutcome(
        { query: TOKEN, embedding: vectorAtCos(1), topK: 1, tagFilter: 'needle' },
        db
      )

      expect(filtered.items.map(r => r.thought.id)).toEqual([tagged])
      expect(filtered.matched).toBe(1)
      expect(filtered.filtered_out).toBe(0)
    }
  )

  itVec('hybrid:false: the vector leg alone finds it, not just the BM25 leg', async db => {
    const tagged = seedWorld(db)

    const unfiltered = await searchThoughtsOutcome(
      {
        query: 'a query with no lexical overlap',
        embedding: vectorAtCos(1),
        hybrid: false,
        topK: 3
      },
      db
    )
    expect(unfiltered.items).toHaveLength(3)
    expect(unfiltered.items.map(r => r.thought.id)).not.toContain(tagged)

    const filtered = await searchThoughtsOutcome(
      {
        query: 'a query with no lexical overlap',
        embedding: vectorAtCos(1),
        hybrid: false,
        topK: 1,
        tagFilter: 'needle'
      },
      db
    )

    expect(filtered.items.map(r => r.thought.id)).toEqual([tagged])
    expect(filtered.items[0].match_source).toEqual(['embedding'])
  })
})

describe('tag naming semantics', () => {
  const TOKEN = 'TAGSEM'

  test('several names in one string are ANDed', async () => {
    const both = seedThought({ content: `${TOKEN} both`, tags: '["alpha","beta"]' })
    const alphaOnly = seedThought({ content: `${TOKEN} alpha`, tags: '["alpha"]' })
    const betaOnly = seedThought({ content: `${TOKEN} beta`, tags: '["beta"]' })

    const outcome = await searchThoughtsOutcome({
      query: TOKEN,
      embedding: BM25_ONLY,
      topK: 10,
      tagFilter: 'alpha,beta'
    })

    const ids = outcome.items.map(r => r.thought.id)
    expect(ids).toContain(both)
    expect(ids).not.toContain(alphaOnly)
    expect(ids).not.toContain(betaOnly)
    expect(outcome.matched).toBe(1)
  })

  test('matching is case-insensitive against the stored spelling', async () => {
    const stored = seedThought({ content: `${TOKEN} mixed`, tags: '["Alpha"]' })
    const other = seedThought({ content: `${TOKEN} other`, tags: '["alphabet"]' })

    const uppercase = await searchThoughtsOutcome({
      query: TOKEN,
      embedding: BM25_ONLY,
      topK: 10,
      tagFilter: 'ALPHA'
    })

    expect(uppercase.items.map(r => r.thought.id)).toEqual([stored])
    expect(uppercase.items.map(r => r.thought.id)).not.toContain(other)
  })

  test('an unknown tag yields no items rather than an unfiltered answer', async () => {
    seedThought({ content: `${TOKEN} untagged one` })
    seedThought({ content: `${TOKEN} untagged two` })

    const outcome = await searchThoughtsOutcome({
      query: TOKEN,
      embedding: BM25_ONLY,
      topK: 10,
      tagFilter: 'no-such-tag'
    })

    expect(outcome.items).toEqual([])
    expect(outcome.matched).toBe(0)
    expect(outcome.filtered_out).toBe(0)
  })

  test('a blank tag does not filter, exactly like an absent one', async () => {
    seedThought({ content: `${TOKEN} blank` })
    seedThought({ content: `${TOKEN} absent` })

    const blank = await searchThoughtsOutcome({
      query: TOKEN,
      embedding: BM25_ONLY,
      topK: 10,
      tagFilter: '  ,  '
    })
    const absent = await searchThoughtsOutcome({ query: TOKEN, embedding: BM25_ONLY, topK: 10 })

    expect(blank.items).toHaveLength(2)
    expect(blank.items.map(r => r.thought.id).sort()).toEqual(
      absent.items.map(r => r.thought.id).sort()
    )
    expect(absent.items).toHaveLength(2)
  })
})

// `outcome.matched` and `outcome.filtered_out` are `meta.counts.total` and
// `meta.counts.filtered_out` verbatim (`src/mcp/tools/recall.ts:137-138`); the wire-level copy of
// this case lives in `src/mcp/tools/recall-tag-filter-counts.contract.test.ts`.
describe('counts keep a tag-removed row out of the arithmetic', () => {
  const TOKEN = 'TAGCNT'

  test('a non-matching row is in neither total nor filtered_out', async () => {
    const keepA = seedThought({ content: `${TOKEN} keep a`, tags: '["beta"]' })
    const keepB = seedThought({ content: `${TOKEN} keep b`, tags: '["beta"]' })
    const dropA = seedThought({ content: `${TOKEN} drop a` })
    const dropB = seedThought({ content: `${TOKEN} drop b` })

    const outcome = await searchThoughtsOutcome({
      query: TOKEN,
      embedding: BM25_ONLY,
      topK: 10,
      tagFilter: 'beta'
    })

    expect(outcome.items.map(r => r.thought.id).sort()).toEqual([keepA, keepB].sort())
    expect(outcome.matched).toBe(2)
    expect(outcome.filtered_out).toBe(0)
    expect(outcome.items.map(r => r.thought.id)).not.toContain(dropA)
    expect(outcome.items.map(r => r.thought.id)).not.toContain(dropB)
  })

  test('a row beyond the limit slice is not filtered_out either', async () => {
    const first = seedThought({ content: `${TOKEN} keep a`, tags: '["beta"]' })
    const second = seedThought({ content: `${TOKEN} keep b`, tags: '["beta"]' })
    seedThought({ content: `${TOKEN} drop a` })

    const outcome = await searchThoughtsOutcome({
      query: TOKEN,
      embedding: BM25_ONLY,
      topK: 1,
      tagFilter: 'beta'
    })

    expect(outcome.items).toHaveLength(1)
    expect([first, second]).toContain(outcome.items[0].thought.id)
    expect(outcome.matched).toBe(2)
    expect(outcome.filtered_out).toBe(0)
  })
})

// SQLite's `NOCASE` folds ASCII only, so the tag filter folds requested and stored names in JS. A
// stored `Тег` therefore answers a request for `тег` (and the reverse); the ASCII-only predicate
// byte-compared the two and answered `no_match`.
describe('non-ASCII tag matching', () => {
  const TOKEN = 'TAGUNI'

  test('a stored `Тег` is found by `тег` and by `ТЕГ`', async () => {
    const stored = seedThought({ content: `${TOKEN} stored`, tags: '["Тег"]' })
    const other = seedThought({ content: `${TOKEN} other`, tags: '["другой"]' })

    for (const request of ['тег', 'ТЕГ']) {
      const outcome = await searchThoughtsOutcome({
        query: TOKEN,
        embedding: BM25_ONLY,
        topK: 10,
        tagFilter: request
      })

      expect(outcome.items.map(r => r.thought.id)).toEqual([stored])
      expect(outcome.items.map(r => r.thought.id)).not.toContain(other)
      expect(outcome.matched).toBe(1)
    }
  })

  test('the reverse holds: a stored `тег` is found by `Тег`', async () => {
    const stored = seedThought({ content: `${TOKEN} stored`, tags: '["тег"]' })
    seedThought({ content: `${TOKEN} other`, tags: '["другой"]' })

    const outcome = await searchThoughtsOutcome({
      query: TOKEN,
      embedding: BM25_ONLY,
      topK: 10,
      tagFilter: 'Тег'
    })

    expect(outcome.items.map(r => r.thought.id)).toEqual([stored])
    expect(outcome.matched).toBe(1)
  })

  test('the fold reaches characters outside the Cyrillic range too', async () => {
    const stored = seedThought({ content: `${TOKEN} umlaut`, tags: '["Ärger"]' })

    const outcome = await searchThoughtsOutcome({
      query: TOKEN,
      embedding: BM25_ONLY,
      topK: 10,
      tagFilter: 'ärger'
    })

    expect(outcome.items.map(r => r.thought.id)).toEqual([stored])
  })

  test('a mixed ASCII/non-ASCII request keeps AND semantics', async () => {
    const both = seedThought({ content: `${TOKEN} both`, tags: '["alpha","Тег"]' })
    seedThought({ content: `${TOKEN} ascii`, tags: '["alpha"]' })
    seedThought({ content: `${TOKEN} uni`, tags: '["Тег"]' })

    for (const request of ['alpha,Тег', 'ALPHA,тег']) {
      const outcome = await searchThoughtsOutcome({
        query: TOKEN,
        embedding: BM25_ONLY,
        topK: 10,
        tagFilter: request
      })

      expect(outcome.items.map(r => r.thought.id)).toEqual([both])
      expect(outcome.matched).toBe(1)
    }
  })
})

// The write path is unchanged and still folds ASCII only (`createTag`/`findTagByName` with
// `idx_tags_name`), so `['Тег','тег']` really creates two tag rows — the state the AND clause must
// survive. The clause counts distinct *requested* names, so two stored spellings satisfy a one-name
// request exactly once.
describe('a thought holding two spellings of one tag', () => {
  const TOKEN = 'TAGSPELL'

  test('the write path stores two rows and a one-name request matches each thought once', async () => {
    const db = getDb()
    const created = createThought(db, {
      content: `${TOKEN} created`,
      status: 'active',
      tags: ['Тег', 'тег']
    }).id
    const replaced = createThought(db, { content: `${TOKEN} replaced`, status: 'active' }).id
    setThoughtTags(db, replaced, ['тег', 'Тег'])

    const tagRows = db.prepare('SELECT name FROM tags ORDER BY name').all() as Array<{
      name: string
    }>
    expect(tagRows.map(r => r.name)).toEqual(['Тег', 'тег'])
    const spellings = ['Тег', 'тег'].sort()
    for (const id of [created, replaced]) {
      expect(
        getThoughtTags(db, id)
          .map(t => t.name)
          .sort()
      ).toEqual(spellings)
    }

    const outcome = await searchThoughtsOutcome({
      query: TOKEN,
      embedding: BM25_ONLY,
      topK: 10,
      tagFilter: 'тег'
    })

    const ids = outcome.items.map(r => r.thought.id)
    expect(ids.sort()).toEqual([created, replaced].sort())
    expect(new Set(ids).size).toBe(2)
    expect(outcome.matched).toBe(2)
  })
})

// The folded clause is resolved once per call and handed to both retrieval legs unchanged: the same
// (requested-name key, tag id) mapping reaches the vec0 leg and the BM25 leg.
describe('the folded tag clause reaches both retrieval legs', () => {
  const TOKEN = 'TAGUNILEG'
  const FILLER = Array.from({ length: 60 }, (_, i) => `unifiller${i}`).join(' ')

  function seedVector(db: Database, id: string, cos: number): void {
    const vector = vectorAtCos(cos)
    db.prepare(`INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, 'default')`).run(
      id,
      Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
    )
  }

  function seedWorld(db: Database, withVectors = true): string {
    for (let i = 0; i < 3; i++) {
      const near = seedThought({ content: `${TOKEN} near ${i}` })
      if (withVectors) seedVector(db, near, 1)
    }
    const tagged = seedThought({ content: `${TOKEN} ${FILLER}`, tags: '["Тег"]' })
    if (withVectors) seedVector(db, tagged, 0.95)
    return tagged
  }

  itVec('the vector leg answers a `тег` request', async db => {
    const tagged = seedWorld(db)

    const outcome = await searchThoughtsOutcome(
      {
        query: 'a query with no lexical overlap',
        embedding: vectorAtCos(1),
        hybrid: false,
        topK: 1,
        tagFilter: 'тег'
      },
      db
    )

    expect(outcome.items.map(r => r.thought.id)).toEqual([tagged])
    expect(outcome.items[0].match_source).toEqual(['embedding'])
  })

  test('the BM25 leg answers the same `тег` request', async () => {
    const tagged = seedWorld(getDb(), false)

    const outcome = await searchThoughtsOutcome({
      query: TOKEN,
      embedding: BM25_ONLY,
      topK: 1,
      tagFilter: 'тег'
    })

    expect(outcome.items.map(r => r.thought.id)).toEqual([tagged])
    expect(outcome.items[0].match_source).toContain('bm25')
  })

  itVec('an unresolvable tag answers nothing and is not reported degraded', async db => {
    seedWorld(db)

    const outcome = await searchThoughtsOutcome(
      {
        query: TOKEN,
        embedding: vectorAtCos(1),
        topK: 5,
        tagFilter: 'нет-такого'
      },
      db
    )

    expect(outcome.items).toEqual([])
    expect(outcome.matched).toBe(0)
    expect((outcome.items as { degraded?: boolean }).degraded).toBe(false)
  })
})
