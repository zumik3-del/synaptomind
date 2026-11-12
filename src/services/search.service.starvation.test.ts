import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { closeDb } from '../db/init'
import { createTestDb, isVecExtensionAvailable, seedThought, withVecDb } from '../test/helpers'
import { DEFAULT_MIN_RELEVANCE } from './search-normalize.service'
import { searchThoughtsOutcome } from './search.service'

/**
 * Task #2505, service layer: the scoped starvation flag is a property of the
 * **vector leg**, not of the fused answer (#2504, ADR `662749c9` §7.4,
 * `docs/mcp-tools.md` "The third case belongs to the vector leg…").
 *
 * Two consequences the docs now state are pinned here, because each breaks the
 * answer-level reading of `degraded` the flag must not drift back to:
 *
 * - a hybrid answer can carry a project row supplied by BM25 while `degraded`
 *   is true — the flag reports the lost semantic reach, not the absence of
 *   every project row;
 * - a project row the vector leg did deliver, then dropped by the relevance
 *   gate, is reported as `counts.filtered_out` while `degraded` stays false, so
 *   a caller must read both fields.
 *
 * `searchThoughtsOutcome` is the surface `memory_recall` turns into
 * `meta.degraded` and `meta.counts.filtered_out`
 * (`src/mcp/tools/recall.ts:143,157-158`), so the outcome fields asserted below
 * are those two envelope fields.
 *
 * The embedding leg is fed a controlled vector (`options.embedding`), so no
 * embedder process runs. vec0 needs a file-backed DB (AGENTS.md §8), so both
 * cases run through `withVecDb`.
 */

const DIM = 384
const VEC_AVAILABLE = isVecExtensionAvailable()

beforeEach(createTestDb)
afterEach(closeDb)

/** A 384-d unit vector whose cosine similarity to `e0` is exactly `cos`. */
function vectorAtCos(cos: number): Float32Array {
  const v = new Float32Array(DIM)
  v[0] = cos
  v[1] = Math.sqrt(Math.max(0, 1 - cos * cos))
  return v
}

/** `e0` — the query vector every fixture similarity is measured against. */
const QUERY = vectorAtCos(1)

function seedVector(db: Database, thoughtId: string, cos: number, scope: string): void {
  const vector = vectorAtCos(cos)
  db.prepare(`INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, ?)`).run(
    thoughtId,
    Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
    scope
  )
}

function itVec(name: string, fn: (db: Database) => void | Promise<void>): void {
  test.skipIf(!VEC_AVAILABLE)(name, () => withVecDb(fn))
}

describe('the scoped starvation flag is a vector-leg property', () => {
  const PROJECT = 'proj-addressed'
  const FOREIGN = 'proj-foreign'
  const TOKEN = 'STARVED_LEG_TOKEN'

  itVec('a BM25-delivered project row does not clear the flag', async db => {
    // The addressed project owns one embedded row the residual filters match,
    // but eight nearer globals fill the leg's whole candidate slice. Only BM25
    // (scoped to project + global) can surface the project row; `topK: 2` makes
    // the service over-fetch `candidateK = 4 × topK = 8`, exactly the size of
    // the global crowd, so the vector leg delivers no project row at all.
    const own = seedThought({ content: `${TOKEN} addressed project note`, project_id: PROJECT })
    seedVector(db, own, 0, PROJECT)
    for (let i = 0; i < 8; i++) {
      const global = seedThought({
        content: `unrelated global filler ${i}`,
        project_id: FOREIGN,
        is_global: 1
      })
      seedVector(db, global, 1, '__global__')
    }

    const outcome = await searchThoughtsOutcome(
      { query: TOKEN, embedding: QUERY, projectFilter: PROJECT, topK: 2 },
      db
    )

    // Intended, not an artefact: the answer *contains* the project row, and it
    // arrived without the vector leg (`match_source` is BM25-only) — so the
    // semantic side demonstrably lost the project while the fused answer still
    // names it. An answer-level flag would have to read false here; the
    // leg-level rule (#2504 blocking 2/3, ADR `662749c9` §7.4 reporting rule)
    // is that the lost semantic reach is reported even when BM25 compensates.
    const hit = outcome.items.find(r => r.thought.id === own)
    expect(hit).toBeDefined()
    expect(hit?.match_source).toEqual(['bm25'])
    expect((outcome.items as { degraded?: boolean }).degraded).toBe(true)
    expect(hit?.degraded).toBe(true)
  })

  itVec('a project row the gate drops is filtered_out, not degraded', async db => {
    // Similarity 0.83 → calibrated relevance 0.3: above the 0.8 unrelated floor
    // (so the row carries a real semantic signal) but below the default 0.4
    // gate, so the gate and nothing else drops it.
    const own = seedThought({
      content: 'PROJECT_GATE_NOTE addressed project note',
      project_id: PROJECT
    })
    seedVector(db, own, 0.83, PROJECT)

    // Control on the same corpus: with the gate off the row is in the answer,
    // which is what proves the vector leg delivered it. Its later absence is
    // therefore the gate's doing, not an empty project (the artefact reading).
    const ungated = await searchThoughtsOutcome(
      {
        query: 'a query with no lexical overlap',
        embedding: QUERY,
        hybrid: false,
        projectFilter: PROJECT,
        topK: 10,
        minRelevance: 0
      },
      db
    )
    expect(ungated.items.map(r => r.thought.id)).toEqual([own])
    expect(ungated.items[0].relevance).toBeLessThan(DEFAULT_MIN_RELEVANCE)
    expect(ungated.filtered_out).toBe(0)

    const gated = await searchThoughtsOutcome(
      {
        query: 'a query with no lexical overlap',
        embedding: QUERY,
        hybrid: false,
        projectFilter: PROJECT,
        topK: 10
      },
      db
    )

    // Intended pairing: the delivered project row is counted in `matched` and
    // `filtered_out` (on the wire, `meta.counts.filtered_out`), while the
    // scoped starvation flag stays false — the project was found and then
    // deliberately rejected, never lost. `degraded` alone would show a
    // project-less answer, which is why the docs require reading both fields
    // (#2504 blocking 2; ADR `662749c9` §7.4, whose reporting rule is about the
    // vector leg's delivered slice, not about the fused answer).
    expect(gated.items).toHaveLength(0)
    expect(gated.matched).toBe(1)
    expect(gated.filtered_out).toBe(1)
    expect((gated.items as { degraded?: boolean }).degraded).toBe(false)
  })
})
