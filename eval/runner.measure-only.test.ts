// #825 contract additions: the `noRelevant` negative-query assertion and
// `measureOnly` feature probes (reported and assertion-gated, but excluded from
// the gated metric aggregates).
//
// Pure cases exercise `evaluateChecks` / `evaluateAssertions` directly; the
// end-to-end case runs the real deterministic `runEval` over a crafted probe set
// so the runner-level wiring is proven: own-set filtering (distractors are not
// "own"), aggregate exclusion, assertion gating and reporting.

import { describe, expect, test } from 'bun:test'
import { EVAL_SCENARIOS } from './datasets'
import {
  collectGatingRegressions,
  evaluateAssertions,
  evaluateChecks,
  runEval,
  type RunResult,
  type ScenarioRun
} from './runner'
import type { EvalScenario } from './types'

describe('evaluateChecks — noRelevant', () => {
  test('passes when none of the scenario own thoughts are retrieved', () => {
    const errors = evaluateChecks(
      { query: 'q', relevant: [], noRelevant: true },
      ['d1', 'd4', 'd6'],
      ['own-a', 'own-b']
    )

    expect(errors).toEqual([])
  })

  test('fails when an own thought leaks into the retrieval', () => {
    const errors = evaluateChecks(
      { query: 'q', relevant: [], noRelevant: true },
      ['own-a', 'd1'],
      ['own-a', 'own-b']
    )

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('noRelevant')
    expect(errors[0]).toContain('own-a')
    expect(errors[0]).not.toContain('own-b')
  })

  test('reports every leaked own thought', () => {
    const errors = evaluateChecks(
      { query: 'q', relevant: [], noRelevant: true },
      ['own-a', 'own-b'],
      ['own-a', 'own-b']
    )

    expect(errors).toHaveLength(2)
  })

  test('retrieved shared distractors never flag: only the own set is asserted', () => {
    // The caller (runEval) passes the scenario's non-distractor ids as the own
    // set; a retrieval filled with distractor ids must be a clean pass.
    const errors = evaluateChecks(
      { query: 'q', relevant: [], noRelevant: true },
      ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'],
      ['own-a', 'own-b']
    )

    expect(errors).toEqual([])
  })

  test('an empty own set is a scoped vacuous pass', () => {
    const errors = evaluateChecks({ query: 'q', relevant: [], noRelevant: true }, ['d1'], [])

    expect(errors).toEqual([])
  })

  test('forbid and rankBefore keep firing alongside noRelevant', () => {
    const errors = evaluateChecks(
      {
        query: 'q',
        relevant: ['a'],
        forbid: ['x'],
        rankBefore: { before: 'a', after: 'b' },
        noRelevant: true
      },
      ['x', 'b', 'a', 'own-a'],
      ['own-a']
    )

    expect(errors).toHaveLength(3)
    expect(errors.some(error => error.includes('forbidden'))).toBe(true)
    expect(errors.some(error => error.includes('ranked below'))).toBe(true)
    expect(errors.some(error => error.includes('noRelevant'))).toBe(true)
  })
})

function scenarioRun(overrides: Partial<ScenarioRun> = {}): ScenarioRun {
  return {
    name: 's',
    category: 'no-match',
    outcome: 'pass',
    status: 'pass',
    metrics: { recall: 0, precision: 0, mrr: 0, hitRate: 0, queries: 1 },
    queries: [],
    checkErrors: [],
    ...overrides
  }
}

function emptyResult(scenarios: ScenarioRun[] = []): RunResult {
  return {
    mode: 'deterministic',
    generatedAt: '2026-01-01T00:00:00.000Z',
    topK: 5,
    scenarios,
    overall: { recall: 0, precision: 0, mrr: 0, hitRate: 0, queries: 0 },
    categories: {}
  }
}

describe('evaluateAssertions — measureOnly gating', () => {
  test('a failing measureOnly scenario still gates', () => {
    const res = emptyResult([
      scenarioRun({
        name: 'probe',
        measureOnly: true,
        status: 'fail',
        checkErrors: ['noRelevant query retrieved scenario thought "nm-garden"']
      })
    ])

    expect(evaluateAssertions(res)).toEqual([
      {
        scope: 'scenario:probe',
        metric: 'assertion',
        actual: 0,
        threshold: 1,
        detail: 'noRelevant query retrieved scenario thought "nm-garden"'
      }
    ])
  })

  test('a passing measureOnly scenario does not gate', () => {
    const res = emptyResult([scenarioRun({ name: 'probe', measureOnly: true })])

    expect(evaluateAssertions(res)).toEqual([])
  })

  test('assertion regressions gate even without a baseline entry', () => {
    const res = emptyResult([
      scenarioRun({ name: 'probe', measureOnly: true, status: 'fail', checkErrors: ['boom'] })
    ])

    expect(collectGatingRegressions(res, null)).toHaveLength(1)
  })
})

describe('runEval — measureOnly end-to-end', () => {
  const gatedFact: EvalScenario = {
    name: 'gated-fact',
    category: 'explicit-fact',
    description: 'single distinctive fact',
    thoughts: [{ id: 'g-only', content: 'distinctive zanzibar lighthouse fact' }],
    queries: [{ query: 'zanzibar lighthouse', relevant: ['g-only'] }]
  }

  function negativeNoMatch(): EvalScenario {
    const scenario = EVAL_SCENARIOS.find(s => s.name === 'negative-no-match')
    if (!scenario) throw new Error('negative-no-match missing from EVAL_SCENARIOS')
    return scenario
  }

  /**
   * The #825 proof-of-gating trick: replace one own thought's content with the
   * query text so the deterministic searcher retrieves it — the noRelevant
   * contract must fire on that leak.
   */
  function leakingNegative(): EvalScenario {
    const scenario = negativeNoMatch()
    const query = scenario.queries[0].query

    return {
      ...scenario,
      name: 'negative-no-match-leak',
      thoughts: scenario.thoughts.map(thought =>
        thought.id === 'nm-garden' ? { ...thought, content: query } : thought
      )
    }
  }

  test('probes are reported and assertion-gated but stay out of the aggregates', async () => {
    const res = await runEval({ scenarios: [gatedFact, negativeNoMatch(), leakingNegative()] })

    const gated = res.scenarios.find(s => s.name === 'gated-fact')!
    const clean = res.scenarios.find(s => s.name === 'negative-no-match')!
    const leak = res.scenarios.find(s => s.name === 'negative-no-match-leak')!

    // Reporting: every scenario run appears, probes carry the measureOnly flag.
    expect(res.scenarios).toHaveLength(3)
    expect(gated.measureOnly).toBe(false)
    expect(clean.measureOnly).toBe(true)
    expect(leak.measureOnly).toBe(true)

    // Behaviour: the shipped probe passes; the injected leak fails noRelevant.
    expect(clean.status).toBe('pass')
    expect(clean.checkErrors).toEqual([])
    expect(leak.status).toBe('fail')
    expect(leak.checkErrors).toEqual([
      'noRelevant query retrieved scenario thought "nm-garden"'
    ])

    // Aggregates: only the gated scenario contributes; no-match has no floor.
    expect(res.overall.queries).toBe(1)
    expect(res.categories['explicit-fact']?.queries).toBe(1)
    expect(res.categories['no-match']).toBeUndefined()

    // Gating: the probe assertion failure is a regression even without a baseline.
    expect(evaluateAssertions(res)).toEqual([
      {
        scope: 'scenario:negative-no-match-leak',
        metric: 'assertion',
        actual: 0,
        threshold: 1,
        detail: 'noRelevant query retrieved scenario thought "nm-garden"'
      }
    ])
    expect(collectGatingRegressions(res, null)).toHaveLength(1)
  })
})
