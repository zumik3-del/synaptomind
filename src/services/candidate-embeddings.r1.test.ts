import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getDb } from '../db/container'
import { getPendingEmbeddingIds, getThoughtEmbeddingsBatch } from '../db/embeddings'
import { closeDb } from '../db/init'
import { createTestDb, drainPendingEmbeddings, seedThought, withVecDb } from '../test/helpers'
import { resolveCandidateEmbeddings } from './candidate-embeddings.service'

/**
 * Task #1570 — R1 freshness pins (independent red-first verification of #1569).
 *
 * R1: a candidate must never be SCORED from a `vec_thoughts` vector that no
 * longer matches its content. `pending_embeddings` is the freshness signal (the
 * v035 trigger queues a row on INSERT and on UPDATE OF content), so any
 * candidate with a pending row is resolved by a LIVE embed of its current
 * content, even when a stored vector exists.
 *
 * The invariants here are pinned at the resolver boundary, where the returned
 * vector identity is observable (slot 0 carries an identity marker) and the
 * embedder call count is explicit. On the pre-#1569 logic
 * (`missing = candidates.filter(c => !stored.has(c.id))`) the OLD marker comes
 * back with zero embedder calls — the exact stale-scoring defect.
 */

beforeEach(createTestDb)
afterEach(closeDb)

/** `vec_thoughts` is `FLOAT[384]`; slot 0 is the identity marker of the vector. */
function vec(marker: number): Float32Array {
  const v = new Float32Array(384)
  v[0] = marker
  return v
}

/** Identity markers of the returned vectors, in candidate order. */
function markers(vectors: Float32Array[]): number[] {
  return vectors.map(v => v[0])
}

/**
 * Insert a stored vector for `id` the way the embedder worker leaves it
 * (DELETE + INSERT, `embedder/queue.ts`) and drain the queued re-embed: this is
 * the production steady state "the stored vector matches the content".
 */
function storeVec(id: string, vector: Float32Array): void {
  getDb()
    .prepare(`INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)`)
    .run(id, Buffer.from(vector.buffer as ArrayBuffer, vector.byteOffset, vector.byteLength))
  drainPendingEmbeddings([id])
}

/** Simulate a content edit: rewrite `content` so the v035 trigger re-queues the row. */
function editContent(id: string, content: string): void {
  getDb().prepare(`UPDATE thoughts SET content = ? WHERE id = ?`).run(content, id)
}

describe('R1 freshness — a pending candidate is embedded live, never scored from its stored vector', () => {
  test('AC1 edit window: a candidate pending after OLD→NEW resolves to the NEW vector with a live embed', async () => {
    await withVecDb(async db => {
      const id = seedThought({ content: 'OLD content' })
      // The vector that matches OLD content, with its queue row already drained.
      storeVec(id, vec(1))
      expect(getPendingEmbeddingIds(db, [id]).has(id)).toBe(false)

      // Edit window: the worker has NOT refreshed vec_thoughts yet, so the stored
      // vector (marker 1) is now stale while pending_embeddings holds the row.
      editContent(id, 'NEW content')
      expect(getPendingEmbeddingIds(db, [id]).has(id)).toBe(true)
      expect(getThoughtEmbeddingsBatch(db, [id]).get(id)![0]).toBe(1)

      const embeddedTexts: string[][] = []
      const result = await resolveCandidateEmbeddings(
        [{ id, content: 'NEW content' }],
        async texts => {
          embeddedTexts.push(texts)
          return texts.map(() => vec(2))
        },
        db
      )

      // The resolver must hand back the NEW-content vector (marker 2), not the
      // stored OLD one (marker 1), and it must have asked the embedder for the
      // candidate's CURRENT content exactly once.
      expect(markers(result)).toEqual([2])
      expect(embeddedTexts).toEqual([['NEW content']])
    })
  })

  test('AC1 pre-fix counter-check: the same fixture reports the stale vector and 0 embed calls when the pending signal is ignored', async () => {
    await withVecDb(async db => {
      const id = seedThought({ content: 'OLD content' })
      storeVec(id, vec(1))
      editContent(id, 'NEW content')

      // This is the pre-#1569 filter (`!stored.has(c.id)`) applied to the SAME
      // fixture, kept read-only: the stored stale row wins and the embedder is
      // never consulted. It documents the defect the production resolver no
      // longer has (asserted in the previous test) instead of merely claiming it.
      const staleIgnoringPending = async (): Promise<{ marker: number; embedCalls: number }> => {
        const stored = getThoughtEmbeddingsBatch(db, [id])
        let embedCalls = 0
        const missing = stored.has(id) ? [] : [{ id, content: 'NEW content' }]
        const embed = async (texts: string[]): Promise<Float32Array[]> => {
          embedCalls++
          return texts.map(() => vec(2))
        }
        if (missing.length > 0) {
          const generated = await embed(missing.map(c => c.content))
          stored.set(id, generated[0]!)
        }
        return { marker: stored.get(id)![0], embedCalls }
      }

      expect(await staleIgnoringPending()).toEqual({ marker: 1, embedCalls: 0 })
      // Same fixture through the production resolver: marker 2 (fresh).
      const live = await resolveCandidateEmbeddings(
        [{ id, content: 'NEW content' }],
        async texts => texts.map(() => vec(2)),
        db
      )
      expect(markers(live)).toEqual([2])
    })
  })

  test('AC2 dead letter (is_error=1): a never-retried candidate is still embedded live', async () => {
    await withVecDb(async db => {
      const id = seedThought({ content: 'OLD content' })
      storeVec(id, vec(1))
      editContent(id, 'NEW content')
      // Dead-letter the queue row exactly as `handleFailedItem` does at
      // MAX_ATTEMPTS (`embedder/queue.ts:51-59`): the worker will never retry it,
      // so the stale vector would otherwise persist forever.
      db.prepare(
        `UPDATE pending_embeddings SET attempts = 10, last_error = 'boom', is_error = 1, error = 'boom' WHERE thought_id = ?`
      ).run(id)

      const row = db
        .prepare(`SELECT is_error FROM pending_embeddings WHERE thought_id = ?`)
        .get(id) as { is_error: number }
      expect(row.is_error).toBe(1)

      const embeddedTexts: string[][] = []
      const result = await resolveCandidateEmbeddings(
        [{ id, content: 'NEW content' }],
        async texts => {
          embeddedTexts.push(texts)
          return texts.map(() => vec(2))
        },
        db
      )

      expect(markers(result)).toEqual([2])
      expect(embeddedTexts).toEqual([['NEW content']])
    })
  })

  test('AC3 no regression of #1566: all candidates fresh and none pending → exactly 0 embed calls', async () => {
    await withVecDb(async db => {
      const candidates = [
        { id: 'a', content: 'alpha' },
        { id: 'b', content: 'beta' },
        { id: 'c', content: 'gamma' }
      ]
      storeVec('a', vec(11))
      storeVec('b', vec(22))
      storeVec('c', vec(33))
      // Steady state precondition: no pending signal for any candidate.
      expect(getPendingEmbeddingIds(db, candidates.map(c => c.id)).size).toBe(0)

      let embedCalls = 0
      const result = await resolveCandidateEmbeddings(
        candidates,
        async texts => {
          embedCalls++
          return texts.map(() => vec(999))
        },
        db
      )

      expect(embedCalls).toBe(0)
      expect(markers(result)).toEqual([11, 22, 33])
    })
  })

  test('AC4 conservative direction: fresh stored vector AND a pending row → embedded live (waste is intended)', async () => {
    await withVecDb(async db => {
      const id = seedThought({ content: 'current content' })
      // The stored vector already matches the content (fresh) AND a queue row is
      // still present — the state a worker refresh between the two reads leaves
      // behind. Re-embedding here is deliberate, harmless waste: it is the price
      // of the no-stale-use guarantee (pending-first read ordering, #1569).
      storeVec(id, vec(1))
      db.prepare(`INSERT OR REPLACE INTO pending_embeddings (thought_id, created_at) VALUES (?, ?)`).run(
        id,
        new Date().toISOString()
      )

      let embedCalls = 0
      const result = await resolveCandidateEmbeddings(
        [{ id, content: 'current content' }],
        async texts => {
          embedCalls++
          return texts.map(() => vec(2))
        },
        db
      )

      expect(embedCalls).toBe(1)
      expect(markers(result)).toEqual([2])
    })
  })
})

describe('AC5 getPendingEmbeddingIds degradation (fail-closed by design)', () => {
  test('an empty id list yields an empty set', async () => {
    await withVecDb(db => {
      expect(getPendingEmbeddingIds(db, [])).toEqual(new Set())
    })
  })

  test('a failed pending read propagates out of the resolver (does NOT degrade to "nothing pending")', async () => {
    await withVecDb(async db => {
      const id = seedThought({ content: 'NEW content' })
      storeVec(id, vec(1))
      // A pending row is present, so production would embed this candidate live.
      db.prepare(`INSERT OR REPLACE INTO pending_embeddings (thought_id, created_at) VALUES (?, ?)`).run(
        id,
        new Date().toISOString()
      )
      db.exec('ALTER TABLE pending_embeddings RENAME TO pending_embeddings_hidden')

      let embedCalls = 0
      const run = resolveCandidateEmbeddings(
        [{ id, content: 'NEW content' }],
        async texts => {
          embedCalls++
          return texts.map(() => vec(2))
        },
        db
      )

      // Fail-CLOSED, not fail-open: an empty pending set would silently score the
      // candidate from its stored vector — exactly the R1 defect. Accepted as
      // deliberate (orchestrator deviation note on task #1570), so the throw is
      // asserted as the contract, and "no stale vector served" is the invariant.
      await expect(run).rejects.toThrow(/pending_embeddings/)
      expect(embedCalls).toBe(0)

      db.exec('ALTER TABLE pending_embeddings_hidden RENAME TO pending_embeddings')
    })
  })

  test('migrations v009/v035 guarantee `pending_embeddings` exists, so the throwing path is unreachable in production', async () => {
    await withVecDb(db => {
      const names = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
        .all() as { name: string }[]
      const present = names.map(n => n.name)
      expect(present).toContain('pending_embeddings')
      // The read the resolver makes, on a fresh migrated DB: no table-missing error.
      expect(getPendingEmbeddingIds(db, ['missing-id'])).toEqual(new Set())
      expect(getPendingEmbeddingIds(db, [])).toEqual(new Set())
    })
  })

  test('confirmed: the pending read does NOT filter on is_error', async () => {
    await withVecDb(db => {
      const dead = seedThought({ content: 'dead lettered' })
      const live = seedThought({ content: 'queued' })
      db.prepare(
        `UPDATE pending_embeddings SET attempts = 10, is_error = 1, error = 'boom' WHERE thought_id = ?`
      ).run(dead)
      expect(getPendingEmbeddingIds(db, [dead, live])).toEqual(new Set([dead, live]))
      expect(getPendingEmbeddingIds(db, [dead])).toEqual(new Set([dead]))
    })
  })
})
