/**
 * Heavy auto-cluster perf suite (task #1569, review finding O4).
 *
 * The 3000-candidate run is an O(N^2) job (row cache ~36 MB, ~4 s measured) and
 * the default `bun test` gate must not carry it: this host also runs prod
 * (AGENTS.md §8). `*.suite.ts` is excluded from the test glob, and the wrapper
 * `auto-cluster.perf.test.ts` spawns it only when `SYNAPTOMIND_PERF_SUITE=1`.
 * The same stored-vector path stays pinned for correctness at N=200 inside the
 * gate (`auto-cluster.service.test.ts`); only the scale/timing assertion is here.
 *
 * Run explicitly:
 *   SYNAPTOMIND_PERF_SUITE=1 bun test ./src/services/auto-cluster.perf.test.ts
 *   bun test ./src/services/auto-cluster.perf.suite.ts
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../db/container'
import { closeDb } from '../db/init'
import { createTestDb, drainPendingEmbeddings, withVecDb } from '../test/helpers'
import { runAutoClusterJob } from './auto-cluster.service'

beforeEach(createTestDb)
afterEach(closeDb)

/**
 * Bulk-seed `count` eligible candidates with stored 384-dim vectors.
 *
 * Duplicated from `auto-cluster.service.test.ts` on purpose: importing a
 * `*.test.ts` here would register that file's tests inside this process, and
 * there is no shared non-test fixture module for it.
 */
function seedClusterCandidates(count: number, past: string): string[] {
  const db = getDb()
  const ids: string[] = []
  const vector = new Float32Array(384)
  vector[0] = 1
  const buffer = Buffer.from(vector.buffer as ArrayBuffer, vector.byteOffset, vector.byteLength)
  const insertThought = db.prepare(`
    INSERT INTO thoughts (id, content, status, source, project_id, is_cluster, is_profile, is_protected, is_global, created_at, updated_at)
    VALUES (?, ?, 'active', 'test', 'default', 0, 0, 1, 0, ?, ?)
  `)
  const insertVec = db.prepare(`INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)`)
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `11111111-1111-7111-8111-${String(i).padStart(12, '0')}`
      ids.push(id)
      insertThought.run(id, `bulk candidate ${i}`, past, past)
      insertVec.run(id, buffer)
    }
  })()
  // Drained: a queued row would force a live re-embed (task #1569, R1), and this
  // suite measures the stored-vector path.
  drainPendingEmbeddings(ids)
  return ids
}

test('runAutoClusterJob: 3000 stored-vector candidates complete well under 10 s with 0 embedder calls', async () => {
  await withVecDb(async () => {
    const past = new Date(Date.now() - 10 * 86400000).toISOString()
    const ids = seedClusterCandidates(3000, past)
    let embedCalls = 0
    const started = performance.now()

    const result = await runAutoClusterJob(
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
    // Every stored vector is [1, 0, ...]: all pairs at distance 0, so one group.
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].members.length).toBe(ids.length)
    expect(elapsedMs).toBeLessThan(10_000)
    console.error(`[task-1569] 3000-candidate auto-cluster: ${elapsedMs.toFixed(0)} ms, ${embedCalls} embedder calls`)
  })
}, 30000)
