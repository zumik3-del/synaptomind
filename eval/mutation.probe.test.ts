// Mutation / regression probe for the #156 expectNoStrongMatch contract.
//
// These tests directly exercise runEval with modified scenarios to verify:
//   1. Forcing a strong match into the negative-no-match scenario makes it fail.
//   2. The negative query shares no token with any corpus thought or distractor.
//   3. With no baseline entry, metric gating is disabled but assertions still gate.
//
// All tests use the local runEval function directly (no subprocess), so import
// paths resolve correctly.

import { describe, expect, test } from 'bun:test'
import { EVAL_SCENARIOS } from './datasets'
import { tokenize } from './embedding'
import { collectGatingRegressions, runEval } from './runner'
import type { EvalQuery } from './types'

describe('expectNoStrongMatch mutation check (direct runEval), #892', () => {
  test('forcing a strong match (BM25 anchor) on the negative query makes it fail', async () => {
    // Build a mutated scenario where an own thought's content matches the query.
    // This creates a BM25-anchored strong match that expectNoStrongMatch must catch.
    const original = EVAL_SCENARIOS.find(s => s.name === 'negative-no-match')!
    const queryText = original.queries[0].query
    const mutated = {
      ...original,
      name: 'negative-no-match-mutated',
      thoughts: original.thoughts.map(thought =>
        thought.id === 'nm-garden' ? { ...thought, content: queryText } : thought
      )
    }

    const res = await runEval({ scenarios: [mutated] })
    const run = res.scenarios[0]

    // The mutated scenario should fail because nm-garden is now retrieved as a strong match.
    expect(run.status).toBe('fail')
    expect(run.checkErrors.length).toBeGreaterThan(0)
    expect(run.checkErrors.some(e => e.includes('strong match'))).toBe(true)
    expect(run.checkErrors.some(e => e.includes('nm-garden'))).toBe(true)

    // Also confirm noRelevant fails because the scenario's own thought was retrieved.
    expect(run.checkErrors.some(e => e.includes('noRelevant'))).toBe(true)

    // The regressions should include both assertion failures.
    const regressions = collectGatingRegressions(res, null)
    expect(regressions.length).toBeGreaterThan(0)
  })

  test('the negative query shares no token with any corpus thought or distractor', () => {
    const scenario = EVAL_SCENARIOS.find(s => s.name === 'negative-no-match')!
    const query = scenario.queries[0] as EvalQuery & { expectNoStrongMatch?: true }

    const corpusTokens = new Set<string>()
    for (const other of EVAL_SCENARIOS) {
      for (const thought of other.thoughts) {
        for (const token of tokenize(thought.content)) corpusTokens.add(token)
      }
      for (const otherQuery of other.queries) {
        if (otherQuery === query) continue
        for (const token of tokenize(otherQuery.query)) corpusTokens.add(token)
      }
    }
    const overlap = tokenize(query.query).filter(token => corpusTokens.has(token))
    expect(overlap, `off-topic query shares tokens: ${overlap.join(', ')}`).toEqual([])
  })

  test('expectNoStrongMatch pass case: all hits are low-confidence', async () => {
    const res = await runEval({ scenarios: [EVAL_SCENARIOS.find(s => s.name === 'negative-no-match')!] })
    const run = res.scenarios[0]

    expect(run.status).toBe('pass')
    expect(run.checkErrors).toEqual([])
    // Every retrieved hit should carry the confidence signal.
    expect(run.queries[0].hits.length).toBeGreaterThan(0)
    for (const hit of run.queries[0].hits) {
      expect(hit.lowConfidence).toBe(true)
    }
  })

  test('no baseline entry: metric gating disabled, assertions still gate', async () => {
    const scenario = EVAL_SCENARIOS.find(s => s.name === 'negative-no-match')!

    // With no baseline entry (`null`) a clean run gates nothing.
    const passing = await runEval({ scenarios: [scenario] })
    expect(passing.scenarios[0].status).toBe('pass')
    expect(collectGatingRegressions(passing, null)).toEqual([])

    // A mutated run that breaks the assertion still gates even though no
    // baseline entry exists: `collectGatingRegressions(result, null)` reports
    // assertion regressions only — metric gating is disabled without a baseline,
    // exactly as `collectGatingRegressions` documents.
    const queryText = scenario.queries[0].query
    const mutated = {
      ...scenario,
      name: 'negative-no-match-mutated',
      thoughts: scenario.thoughts.map((thought: { id: string; content: string }) =>
        thought.id === 'nm-garden' ? { ...thought, content: queryText } : thought
      )
    }
    const failing = await runEval({ scenarios: [mutated] })
    expect(failing.scenarios[0].status).toBe('fail')

    const regressions = collectGatingRegressions(failing, null)
    expect(regressions.length).toBeGreaterThan(0)
    expect(regressions.every(r => r.metric === 'assertion')).toBe(true)
  })
})
