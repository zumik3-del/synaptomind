import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getDb } from '../context/container'
import { getPendingEmbeddingIds, getThoughtEmbeddingsBatch } from '../db/embeddings'
import { closeDb } from '../db/init'
import { createTestDb, drainPendingEmbeddings, seedThought, withVecDb } from '../test/helpers'
import { resolveCandidateEmbeddings } from './candidate-embeddings.service'

beforeEach(createTestDb)
afterEach(closeDb)

function vec(marker: number): Float32Array {
  const v = new Float32Array(384)
  v[0] = marker
  return v
}

function markers(vectors: Float32Array[]): number[] {
  return vectors.map(v => v[0])
}

function storeVec(id: string, vector: Float32Array): void {
  getDb()
    .prepare(`INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, 'default')`)
    .run(id, Buffer.from(vector.buffer as ArrayBuffer, vector.byteOffset, vector.byteLength))
  drainPendingEmbeddings([id])
}

function editContent(id: string, content: string): void {
  getDb().prepare(`UPDATE thoughts SET content = ? WHERE id = ?`).run(content, id)
}

describe('R1 freshness — a pending candidate is embedded live, never scored from its stored vector', () => {
  test('AC1 edit window: a candidate pending after OLD→NEW resolves to the NEW vector with a live embed', async () => {
    await withVecDb(async db => {
      const id = seedThought({ content: 'OLD content' })
      storeVec(id, vec(1))
      expect(getPendingEmbeddingIds(db, [id]).has(id)).toBe(false)

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

      expect(markers(result)).toEqual([2])
      expect(embeddedTexts).toEqual([['NEW content']])
    })
  })

  test('AC1 pre-fix counter-check: the same fixture reports the stale vector and 0 embed calls when the pending signal is ignored', async () => {
    await withVecDb(async db => {
      const id = seedThought({ content: 'OLD content' })
      storeVec(id, vec(1))
      editContent(id, 'NEW content')

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
      expect(
        getPendingEmbeddingIds(
          db,
          candidates.map(c => c.id)
        ).size
      ).toBe(0)

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
      storeVec(id, vec(1))
      db.prepare(
        `INSERT OR REPLACE INTO pending_embeddings (thought_id, created_at) VALUES (?, ?)`
      ).run(id, new Date().toISOString())

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

describe('AC5 getPendingEmbeddingIds degradation (fail-closed AND available)', () => {
  test('an empty id list yields an empty set', async () => {
    await withVecDb(db => {
      expect(getPendingEmbeddingIds(db, [])).toEqual(new Set())
    })
  })

  test('a failed pending read degrades to "every candidate is pending" and still serves no stale vector', async () => {
    await withVecDb(async db => {
      const id = seedThought({ content: 'NEW content' })
      storeVec(id, vec(1))
      db.prepare(
        `INSERT OR REPLACE INTO pending_embeddings (thought_id, created_at) VALUES (?, ?)`
      ).run(id, new Date().toISOString())
      db.exec('ALTER TABLE pending_embeddings RENAME TO pending_embeddings_hidden')

      let embedCalls = 0
      const result = await resolveCandidateEmbeddings(
        [{ id, content: 'NEW content' }],
        async texts => {
          embedCalls++
          return texts.map(() => vec(2))
        },
        db
      )

      expect(markers(result)).toEqual([2])
      expect(embedCalls).toBe(1)

      db.exec('ALTER TABLE pending_embeddings_hidden RENAME TO pending_embeddings')
    })
  })

  test('migrations v009/v035 guarantee `pending_embeddings` exists, so the read-error fallback stays an edge path', async () => {
    await withVecDb(db => {
      const names = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
        .all() as { name: string }[]
      const present = names.map(n => n.name)
      expect(present).toContain('pending_embeddings')
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
