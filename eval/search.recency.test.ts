// Recency option forwarding (#825): proves the deterministic searcher passes
// `recencyWeight` / `recencyHalfLifeDays` into `SearchServiceOptions` verbatim.
//
// Instead of spying the service module (`mock.module` would pollute every later
// suite in the same process), assert the effect only forwarded options produce:
// re-rank the shipped `recency-prefers-fresh` scenario and pin the per-result
// `recency_score = 0.5^(ageDays/halfLifeDays)` values. The scenario pins FRESH
// to ~1 day and STALE to ~60 days, so with the forwarded half-life of 1 day the
// scores land at ~0.5 and ~0 — a default 30-day half-life would give ~0.977 and
// 0.25, so the asserted values prove both fields reached the DB ranking layer.
// The embedder child is never spawned (deterministic feature hashing).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb, initDb } from '../src/db'
import { EVAL_SCENARIOS } from './datasets'
import { createDeterministicSearcher, deterministicEmbedder } from './search'
import { seedScenario } from './seed'
import type { EvalScenario } from './types'

function recencyScenario(): EvalScenario {
  const scenario = EVAL_SCENARIOS.find(s => s.name === 'recency-prefers-fresh')
  if (!scenario) throw new Error('recency-prefers-fresh missing from EVAL_SCENARIOS')
  return scenario
}

let dir: string

beforeEach(async () => {
  // vec0 is unavailable in :memory: — the search path needs a file-backed DB.
  dir = mkdtempSync(join(tmpdir(), 'eval-search-recency-'))
  initDb({ dbPath: join(dir, 'db.sqlite'), runMigrations: true })
  await seedScenario(getDb(), recencyScenario(), deterministicEmbedder())
})

afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('deterministic searcher — recency option forwarding', () => {
  test('no options: relevance-only order, no recency fields on the results', async () => {
    const searcher = createDeterministicSearcher()
    const found = await searcher(recencyScenario().queries[0].query, 5)
    const ids = found.map(result => result.thought.id)

    // Without the boost the content-matching stale thought outranks the fresh one.
    expect(ids.indexOf('rec-stale')).toBeGreaterThanOrEqual(0)
    expect(ids.indexOf('rec-stale')).toBeLessThan(ids.indexOf('rec-fresh'))
    for (const result of found) {
      expect(result.recency_score, 'weight unset omits the recency fields').toBeUndefined()
      expect(result.final_score).toBeUndefined()
    }
  })

  test('an explicit recencyWeight 0 preserves the relevance-only order', async () => {
    const searcher = createDeterministicSearcher()
    const found = await searcher(recencyScenario().queries[0].query, 5, undefined, {
      recencyWeight: 0
    })
    const ids = found.map(result => result.thought.id)

    expect(ids.indexOf('rec-stale')).toBeLessThan(ids.indexOf('rec-fresh'))
    for (const result of found) expect(result.recency_score).toBeUndefined()
  })

  test('forwarded {weight: 1, halfLife: 1} flips the ranking to the fresh thought', async () => {
    const searcher = createDeterministicSearcher()
    const found = await searcher(recencyScenario().queries[0].query, 5, undefined, {
      recencyWeight: 1,
      recencyHalfLifeDays: 1
    })
    const ids = found.map(result => result.thought.id)

    expect(ids.indexOf('rec-fresh')).toBeLessThan(ids.indexOf('rec-stale'))

    const fresh = found.find(result => result.thought.id === 'rec-fresh')!
    const stale = found.find(result => result.thought.id === 'rec-stale')!
    expect(fresh.recency_score).toBeGreaterThan(0.49)
    expect(fresh.recency_score).toBeLessThan(0.51)
    // 0.5^(~60/1) ≈ 0; a default 30-day half-life would have produced 0.25 here.
    expect(stale.recency_score).toBeLessThan(0.001)
    expect(fresh.final_score).toBeDefined()
    expect(stale.final_score).toBeDefined()
  })
})
