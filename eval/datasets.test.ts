import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { EVAL_SCENARIOS } from './datasets'
import { loadThresholds, runEval } from './runner'
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
  test('covers all eight issue #124 categories, exactly one gated scenario each', () => {
    // Measure-only feature probes (recency, no-match) are reported but excluded
    // from the gated aggregates, so they must not disturb the #124 coverage.
    const categories = EVAL_SCENARIOS.filter(scenario => !scenario.measureOnly).map(
      scenario => scenario.category
    )

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

  test('only the contradiction scenario is xfail', () => {
    for (const scenario of EVAL_SCENARIOS) {
      const expected = scenario.category === 'contradiction'
      expect(scenario.outcome === 'xfail', scenario.name).toBe(expected)
    }
  })

  test('xfail scenarios assert the missing capability through forbidden ids', () => {
    const xfail = EVAL_SCENARIOS.filter(scenario => scenario.outcome === 'xfail')

    expect(xfail).toHaveLength(1)
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

    // The contradiction scenario is still xfail and contributes no counts to
    // the gated aggregates; the supersession scenario now gates for real.
    expect(res.overall.queries).toBeGreaterThan(0)
    expect(res.categories.supersession?.queries).toBe(1)
    expect(res.categories.contradiction).toBeUndefined()
  })
})

function scenarioNamed(name: string): Extract<typeof EVAL_SCENARIOS[number], { name: string }> {
  const scenario = EVAL_SCENARIOS.find(s => s.name === name)
  expect(scenario, `scenario ${name} missing from EVAL_SCENARIOS`).toBeDefined()
  if (!scenario) throw new Error(`scenario ${name} missing`)
  return scenario as Extract<typeof EVAL_SCENARIOS[number], { name: string }>
}

describe('feature-probe dataset audit (#825)', () => {
  test('recency-prefers-fresh is a measureOnly temporal probe that declares the opt-in recency pair', () => {
    const scenario = scenarioNamed('recency-prefers-fresh')

    expect(scenario.category).toBe('temporal')
    expect(scenario.measureOnly).toBe(true)

    const query = scenario.queries[0]
    expect(query.recencyWeight).toBe(1)
    expect(query.recencyHalfLifeDays).toBe(1)
    expect(query.rankBefore).toEqual({ before: 'rec-fresh', after: 'rec-stale' })
    expect(query.relevant).toEqual(['rec-fresh'])

    // The probe's own thoughts are pinned to contrasting ages; shared distractors
    // are pinned to the stale timestamp so they cannot swamp the pair.
    const fresh = scenario.thoughts.find(thought => thought.id === 'rec-fresh')!
    const stale = scenario.thoughts.find(thought => thought.id === 'rec-stale')!
    expect(new Date(fresh.createdAt!).getTime()).toBeGreaterThan(new Date(stale.createdAt!).getTime())
    const distractorAges = scenario.thoughts.filter(thought => thought.distractor).map(thought => thought.createdAt)
    expect(distractorAges.length).toBeGreaterThan(0)
    for (const age of distractorAges) expect(age).toBe(stale.createdAt)
  })

  test('negative-no-match is a measureOnly no-match probe with a noRelevant query', () => {
    const scenario = scenarioNamed('negative-no-match')

    expect(scenario.category).toBe('no-match')
    expect(scenario.measureOnly).toBe(true)

    const query = scenario.queries[0]
    expect(query.noRelevant).toBe(true)
    expect(query.relevant).toEqual([])

    const own = scenario.thoughts.filter(thought => thought.distractor !== true)
    const shared = scenario.thoughts.filter(thought => thought.distractor === true)
    expect(own.map(thought => thought.id).sort()).toEqual(['nm-garden', 'nm-sourdough'])
    expect(shared.length).toBeGreaterThan(0)
  })

  test('the probe scenarios are reported but stay out of the gated aggregates', async () => {
    const res = await runEval()

    expect(res.scenarios.map(scenario => scenario.name)).toEqual(EVAL_SCENARIOS.map(scenario => scenario.name))
    expect(res.scenarios.filter(scenario => scenario.measureOnly).map(scenario => scenario.name)).toEqual([
      'recency-prefers-fresh',
      'negative-no-match'
    ])
    expect(res.categories['no-match']).toBeUndefined()

    // Only non-measureOnly non-xfail scenarios contribute to the overall query count.
    const gatedQueries = EVAL_SCENARIOS.filter(
      scenario => !scenario.measureOnly && scenario.outcome !== 'xfail'
    ).reduce((count, scenario) => count + scenario.queries.length, 0)
    expect(res.overall.queries).toBe(gatedQueries)
  })

  test('measure-only categories carry no threshold floor in eval/thresholds.json', () => {
    // A floor recorded for a measure-only category would never be reached by any
    // passing scenario and evaluateThresholds would raise a perpetual
    // 'category has no passing scenarios' regression — false-gating the entire
    // mode on a category that is not supposed to gate.
    const file = loadThresholds(join(import.meta.dir, 'thresholds.json'))
    expect(file, 'eval/thresholds.json must exist').not.toBeNull()

    const probeCategories = [
      ...new Set(EVAL_SCENARIOS.filter(scenario => scenario.measureOnly).map(scenario => scenario.category))
    ]
    expect(probeCategories.sort()).toEqual(['no-match', 'temporal'])

    for (const entry of Object.values(file!.modes)) {
      expect(entry.thresholds.categories['no-match'], `${entry.mode} no-match floor`).toBeUndefined()
      expect(entry.baseline.categories['no-match']).toBeUndefined()
    }
  })
})
