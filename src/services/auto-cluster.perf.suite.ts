import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../context/container'
import { closeDb } from '../db/init'
import { createTestDb, drainPendingEmbeddings, withVecDb } from '../test/helpers'
import { runAutoCluster } from './auto-cluster.service'

beforeEach(createTestDb)
afterEach(closeDb)

function seedClusterCandidates(count: number, past: string): string[] {
  const db = getDb()
  const ids: string[] = []
  const vector = new Float32Array(384)
  vector[0] = 1
  const buffer = Buffer.from(vector.buffer as ArrayBuffer, vector.byteOffset, vector.byteLength)
  const insertThought = db.prepare(`
    INSERT INTO thoughts (id, content, status, source, project_id, is_cluster, is_protected, is_global, created_at, updated_at)
    VALUES (?, ?, 'active', 'test', 'default', 0, 1, 0, ?, ?)
  `)
  const insertVec = db.prepare(
    `INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, 'default')`
  )
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `11111111-1111-7111-8111-${String(i).padStart(12, '0')}`
      ids.push(id)
      insertThought.run(id, `bulk candidate ${i}`, past, past)
      insertVec.run(id, buffer)
    }
  })()
  drainPendingEmbeddings(ids)
  return ids
}

test('runAutoCluster: 3000 stored-vector candidates complete well under 10 s with 0 embedder calls', async () => {
  await withVecDb(async () => {
    const past = new Date(Date.now() - 10 * 86400000).toISOString()
    const ids = seedClusterCandidates(3000, past)
    let embedCalls = 0
    const started = performance.now()

    const result = await runAutoCluster(
      { minAgeDays: 0, minMembers: 2, minSimilarity: 0.3, dryRun: true },
      {
        embed: async texts => {
          embedCalls++
          return texts.map(() => new Float32Array(384))
        }
      }
    )
    const elapsedMs = performance.now() - started

    expect(embedCalls).toBe(0)
    expect(result.candidates).toBe(3000)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].members.length).toBe(ids.length)
    expect(elapsedMs).toBeLessThan(10_000)
    console.error(
      `[task-1569] 3000-candidate auto-cluster: ${elapsedMs.toFixed(0)} ms, ${embedCalls} embedder calls`
    )
  })
}, 30000)
