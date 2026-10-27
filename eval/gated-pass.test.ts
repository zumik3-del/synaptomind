// The report-only gated pass (task #2191) — wiring proof (task #2192).
//
// `runEvalWithGate` runs the same scenarios twice: once with `minRelevance: 0`
// (the pass thresholds and the exit code gate on) and once with the gate
// *unset*, so the search service resolves the production default exactly as the
// MCP/HTTP surface does. These tests pin the three claims that wiring makes:
//
// 1. the gated pass really carries the production default, not a harness-local
//    copy of the number (resolved through the service normalizer, compared to
//    `DEFAULT_MIN_RELEVANCE`),
// 2. its `droppedRows` bookkeeping is the service's own `filtered_out` summed
//    over the pass — measured independently here by replaying the same scenario
//    through the deterministic outcome searcher,
// 3. the gate is what moves the numbers: the ungated pass drops nothing.
//
// A token-disjoint query reaches the vector leg only at noise similarity, so
// the calibrated gate drops those rows. vec0 needs a file-backed DB
// (AGENTS.md §8); the deterministic embedder keeps the run model-free.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb, initDb } from '../src/db'
import { DEFAULT_MIN_RELEVANCE } from '../src/services/search-normalize'
import { DEFAULT_TOP_K, runEvalWithGate } from './runner'
import {
  createDeterministicOutcomeSearcher,
  deterministicEmbedder,
  HARNESS_MIN_RELEVANCE,
  resolveDefaultMinRelevance
} from './search'
import { seedScenario } from './seed'
import type { EvalScenario } from './types'

/** A query with no token in common with the corpus: BM25 empty, cosine ~noise. */
const SCENARIO: EvalScenario = {
  name: 'weak-cosine',
  category: 'explicit-fact',
  description: 'a token-disjoint query only reaches the vector leg at noise similarity',
  thoughts: [
    { id: 'weak-a', content: 'annual maintenance window for the vacuum job' },
    { id: 'weak-b', content: 'restoring a backup after a failed update' },
    { id: 'weak-c', content: 'unloading the embedding worker when idle' }
  ],
  queries: [{ query: 'quarterly quokka xylophone horoscope', relevant: ['weak-a'] }]
}

let dir: string | undefined

afterEach(() => {
  closeDb()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('runEvalWithGate — the gated pass uses the production gate', () => {
  test('the gated pass resolves the production default while the ungated pass pins 0', async () => {
    const passes = await runEvalWithGate({ scenarios: [SCENARIO] })

    const defaultGate = await resolveDefaultMinRelevance()

    // The harness resolves the threshold through the service's own normalizer,
    // so it cannot drift from the value production applies.
    expect(defaultGate).toBe(DEFAULT_MIN_RELEVANCE)
    expect(passes.gated.relevanceGate?.minRelevance).toBe(defaultGate)
    expect(passes.gated.relevanceGate?.minRelevance).toBeGreaterThan(HARNESS_MIN_RELEVANCE)

    // The measured pass keeps the fail-open set the recorded baselines used.
    expect(HARNESS_MIN_RELEVANCE).toBe(0)
    expect(passes.ungated.relevanceGate?.minRelevance).toBe(HARNESS_MIN_RELEVANCE)

    // And the gate is what changes the numbers: noise-level vector rows survive
    // the ungated pass and are dropped by the gated one, which costs recall.
    expect(passes.ungated.relevanceGate?.droppedRows).toBe(0)
    expect(passes.gated.relevanceGate?.droppedRows).toBeGreaterThan(0)
    expect(passes.gated.relevanceGate?.queriesWithDrops).toBe(1)
    expect(passes.gated.overall.recall).toBeLessThan(passes.ungated.overall.recall)
  })

  test('droppedRows is the service filtered_out summed over the pass (independent replay)', async () => {
    const passes = await runEvalWithGate({ scenarios: [SCENARIO] })

    // Replay the same scenario and queries through the deterministic outcome
    // searcher, i.e. the same production service path the harness uses, and sum
    // the bookkeeping it reports. This is an independent measurement of the
    // number the report carries, not a re-read of `runEval`'s own accumulator.
    dir = mkdtempSync(join(tmpdir(), 'eval-gated-pass-'))
    closeDb()
    initDb({ dbPath: join(dir, 'scenario.db'), runMigrations: true })
    await seedScenario(getDb(), SCENARIO, deterministicEmbedder())

    const searcher = createDeterministicOutcomeSearcher(undefined, 'default')
    let summedFilteredOut = 0
    let summedCandidates = 0
    let queriesWithDrops = 0
    for (const query of SCENARIO.queries) {
      const output = await searcher(query.query, query.topK ?? DEFAULT_TOP_K, query.projectFilter, {
        recencyWeight: query.recencyWeight,
        recencyHalfLifeDays: query.recencyHalfLifeDays
      })
      summedFilteredOut += output.filteredOut
      summedCandidates += output.hits.length + output.filteredOut
      if (output.filteredOut > 0) queriesWithDrops += 1
    }

    // Positive control: the replay really did exercise a gate that dropped rows.
    expect(summedFilteredOut).toBeGreaterThan(0)

    expect(passes.gated.relevanceGate?.droppedRows).toBe(summedFilteredOut)
    expect(passes.gated.relevanceGate?.candidates).toBe(summedCandidates)
    expect(passes.gated.relevanceGate?.queriesWithDrops).toBe(queriesWithDrops)
    // The ungated pass reports the same candidates and no drops at all.
    expect(passes.ungated.relevanceGate?.candidates).toBe(summedCandidates)
    expect(passes.ungated.relevanceGate?.droppedRows).toBe(0)
  })
})
