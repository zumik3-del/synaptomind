import { describe, expect, test } from 'bun:test'
import { EVAL_SCENARIOS } from './datasets'
import { runEval } from './runner'
import type { EvalCategory } from './types'

// The eight categories required by issue #124 item 1.
const REQUIRED_CATEGORIES: EvalCategory[] = [
  'explicit-fact',
  'multi-hop',
  'temporal',
  'supersession',
  'contradiction',
  'consolidation',
  'project-scope',
  'retrieval-quality'
]

const DEFAULT_TOP_K = 5

describe('dataset coverage', () => {
  test('covers all eight issue #124 categories, exactly one scenario each', () => {
    const categories = EVAL_SCENARIOS.map(scenario => scenario.category)

    expect([...new Set(categories)].sort()).toEqual([...REQUIRED_CATEGORIES].sort())
    expect(categories).toHaveLength(REQUIRED_CATEGORIES.length)
  })

  test('scenario names are unique', () => {
    const names = EVAL_SCENARIOS.map(scenario => scenario.name)

    expect(new Set(names).size).toBe(names.length)
  })

  test('every scenario declares at least one thought and one query', () => {
    for (const scenario of EVAL_SCENARIOS) {
      expect(scenario.thoughts.length, scenario.name).toBeGreaterThan(0)
      expect(scenario.queries.length, scenario.name).toBeGreaterThan(0)
    }
  })

  test('every referenced id exists inside its scenario', () => {
    for (const scenario of EVAL_SCENARIOS) {
      const ids = new Set(scenario.thoughts.map(thought => thought.id))
      for (const query of scenario.queries) {
        for (const id of query.relevant) {
          expect(ids.has(id), `${scenario.name}: relevant ${id}`).toBe(true)
        }
        for (const id of query.forbid ?? []) {
          expect(ids.has(id), `${scenario.name}: forbid ${id}`).toBe(true)
        }
        if (query.rankBefore) {
          expect(ids.has(query.rankBefore.before), `${scenario.name}: before`).toBe(true)
          expect(ids.has(query.rankBefore.after), `${scenario.name}: after`).toBe(true)
        }
      }
      for (const edge of scenario.edges ?? []) {
        expect(ids.has(edge.source), `${scenario.name}: edge source`).toBe(true)
        expect(ids.has(edge.target), `${scenario.name}: edge target`).toBe(true)
      }
    }
  })

  test('only supersession and contradiction are xfail', () => {
    for (const scenario of EVAL_SCENARIOS) {
      const expected = scenario.category === 'supersession' || scenario.category === 'contradiction'
      expect(scenario.outcome === 'xfail', scenario.name).toBe(expected)
    }
  })

  test('xfail scenarios assert the missing capability through forbidden ids', () => {
    const xfail = EVAL_SCENARIOS.filter(scenario => scenario.outcome === 'xfail')

    expect(xfail).toHaveLength(2)
    for (const scenario of xfail) {
      expect(
        scenario.queries.some(query => (query.forbid?.length ?? 0) > 0),
        scenario.name
      ).toBe(true)
    }
  })

  test('pass scenarios have distractors (more thoughts than top-k) for meaningful precision', () => {
    for (const scenario of EVAL_SCENARIOS.filter(s => s.outcome !== 'xfail')) {
      expect(scenario.thoughts.length, scenario.name).toBeGreaterThan(DEFAULT_TOP_K)
    }
  })
})

describe('dataset behaviour (end-to-end)', () => {
  test('every pass scenario passes and every xfail scenario still exercises its gap', async () => {
    const res = await runEval()

    expect(res.scenarios).toHaveLength(EVAL_SCENARIOS.length)
    for (const scenario of res.scenarios) {
      if (scenario.outcome === 'pass') {
        expect(scenario.status, scenario.name).toBe('pass')
        expect(scenario.checkErrors, scenario.name).toEqual([])
      } else {
        // The gap is real today: the forbidden thought IS retrieved. If this ever
        // reports xpass, the capability shipped — promote the scenario to pass.
        expect(scenario.status, scenario.name).toBe('xfail')
        expect(scenario.checkErrors.length, scenario.name).toBeGreaterThan(0)
      }
    }

    // xfail scenarios contribute no counts to the gated aggregates.
    expect(res.overall.queries).toBeGreaterThan(0)
    expect(res.categories.supersession).toBeUndefined()
    expect(res.categories.contradiction).toBeUndefined()
  })
})
