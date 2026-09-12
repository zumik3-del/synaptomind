import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildThresholdEntry,
  collectGatingRegressions,
  evaluateAssertions,
  evaluateChecks,
  evaluateThresholds,
  loadThresholds,
  type MetricFloor,
  type QueryRun,
  type RunResult,
  runEval,
  type ScenarioRun,
  summariseScenario,
  type ThresholdEntry,
  upsertThresholdEntry,
  writeThresholds
} from './runner'
import type { AggregateMetrics, EvalScenario, QueryMetrics } from './types'

const ZERO: AggregateMetrics = { recall: 0, precision: 0, mrr: 0, hitRate: 0, queries: 0 }

function queryRun(metrics: Partial<QueryMetrics> = {}): QueryRun {
  return {
    query: 'q',
    relevant: ['a'],
    metrics: {
      recall: 1,
      precision: 1,
      mrr: 1,
      hit: 1,
      retrieved: ['a'],
      checkErrors: [],
      ...metrics
    }
  }
}

function scenarioRun(overrides: Partial<ScenarioRun> = {}): ScenarioRun {
  return {
    name: 's',
    category: 'explicit-fact',
    outcome: 'pass',
    status: 'pass',
    metrics: { recall: 1, precision: 1, mrr: 1, hitRate: 1, queries: 1 },
    queries: [],
    checkErrors: [],
    ...overrides
  }
}

function result(overrides: Partial<RunResult> = {}): RunResult {
  return {
    mode: 'deterministic',
    generatedAt: '2026-01-01T00:00:00.000Z',
    topK: 5,
    scenarios: [],
    overall: ZERO,
    categories: {},
    ...overrides
  }
}

const FLOOR_ONE: MetricFloor = { recall: 1, precision: 1, mrr: 1, hitRate: 1 }

function thresholdEntry(overrides: Partial<ThresholdEntry> = {}): ThresholdEntry {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: 'deterministic',
    baseline: { overall: ZERO, categories: {} },
    thresholds: { overall: { ...FLOOR_ONE }, categories: {} },
    ...overrides
  }
}

describe('evaluateChecks', () => {
  test('returns no errors for a clean retrieval', () => {
    expect(evaluateChecks({ query: 'q', relevant: ['a'] }, ['a', 'b'])).toEqual([])
  })

  test('flags a forbidden thought that was retrieved', () => {
    const errors = evaluateChecks({ query: 'q', relevant: ['a'], forbid: ['b'] }, ['a', 'b'])

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('forbidden')
    expect(errors[0]).toContain('b')
  })

  test('does not flag a forbidden thought that was not retrieved', () => {
    expect(evaluateChecks({ query: 'q', relevant: ['a'], forbid: ['b'] }, ['a'])).toEqual([])
  })

  test('passes when the expected thought ranks above the other', () => {
    const errors = evaluateChecks(
      { query: 'q', relevant: ['a'], rankBefore: { before: 'a', after: 'b' } },
      ['a', 'b']
    )

    expect(errors).toEqual([])
  })

  test('flags a reversed rank order', () => {
    const errors = evaluateChecks(
      { query: 'q', relevant: ['a'], rankBefore: { before: 'a', after: 'b' } },
      ['b', 'a']
    )

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('ranked below')
  })

  test('flags a "before" thought that was not retrieved', () => {
    const errors = evaluateChecks(
      { query: 'q', relevant: ['a'], rankBefore: { before: 'a', after: 'b' } },
      ['b']
    )

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('not retrieved')
  })

  test('does not flag when only the "after" thought is absent', () => {
    const errors = evaluateChecks(
      { query: 'q', relevant: ['a'], rankBefore: { before: 'a', after: 'b' } },
      ['a']
    )

    expect(errors).toEqual([])
  })
})

describe('summariseScenario', () => {
  const scenario: EvalScenario = {
    name: 's',
    category: 'explicit-fact',
    description: '',
    thoughts: [],
    queries: []
  }

  test('a clean scenario is a pass and aggregates its queries', () => {
    const run = summariseScenario(scenario, [queryRun(), queryRun({ recall: 0.5 })])

    expect(run.outcome).toBe('pass')
    expect(run.status).toBe('pass')
    expect(run.checkErrors).toEqual([])
    expect(run.metrics.queries).toBe(2)
    expect(run.metrics.recall).toBe(0.75)
  })

  test('a failed assertion makes a normal scenario fail', () => {
    const run = summariseScenario(scenario, [queryRun({ checkErrors: ['boom'] })])

    expect(run.outcome).toBe('pass')
    expect(run.status).toBe('fail')
    expect(run.checkErrors).toEqual(['boom'])
  })

  test('an xfail scenario with a failing assertion reports xfail', () => {
    const run = summariseScenario({ ...scenario, outcome: 'xfail' }, [
      queryRun({ checkErrors: ['boom'] })
    ])

    expect(run.outcome).toBe('xfail')
    expect(run.status).toBe('xfail')
  })

  test('an xfail scenario that unexpectedly passes reports xpass', () => {
    const run = summariseScenario({ ...scenario, outcome: 'xfail' }, [queryRun()])

    expect(run.outcome).toBe('xfail')
    expect(run.status).toBe('xpass')
  })
})

describe('buildThresholdEntry', () => {
  test('subtracts the margin, clamps at zero and records the rounded baseline', () => {
    const entry = buildThresholdEntry(
      result({ overall: { recall: 0.5, precision: 0.01, mrr: 0.9, hitRate: 1, queries: 3 } }),
      0.02
    )

    expect(entry.mode).toBe('deterministic')
    expect(entry.thresholds.overall).toEqual({
      recall: 0.48,
      precision: 0,
      mrr: 0.88,
      hitRate: 0.98
    })
    expect(entry.baseline.overall).toEqual({
      recall: 0.5,
      precision: 0.01,
      mrr: 0.9,
      hitRate: 1,
      queries: 3
    })
  })

  test('builds per-category floors alongside the overall floor', () => {
    const entry = buildThresholdEntry(
      result({ categories: { 'multi-hop': { recall: 1, precision: 0.3, mrr: 1, hitRate: 1, queries: 2 } } })
    )

    expect(entry.thresholds.categories['multi-hop']).toEqual({
      recall: 0.98,
      precision: 0.28,
      mrr: 0.98,
      hitRate: 0.98
    })
    expect(entry.baseline.categories['multi-hop']?.precision).toBe(0.3)
  })
})

describe('evaluateThresholds', () => {
  test('a result exactly at the thresholds passes', () => {
    const res = result({ overall: { recall: 1, precision: 1, mrr: 1, hitRate: 1, queries: 1 } })

    expect(evaluateThresholds(res, thresholdEntry())).toEqual([])
  })

  test('a metric below its floor is reported as a regression', () => {
    const res = result({ overall: { recall: 0.9, precision: 1, mrr: 1, hitRate: 1, queries: 1 } })

    expect(evaluateThresholds(res, thresholdEntry())).toEqual([
      { scope: 'overall', metric: 'recall', actual: 0.9, threshold: 1 }
    ])
  })

  test('a gated category missing from the run is reported as absent', () => {
    const res = result({ overall: { recall: 1, precision: 1, mrr: 1, hitRate: 1, queries: 1 } })
    const entry = thresholdEntry({
      thresholds: {
        overall: { ...FLOOR_ONE },
        categories: { 'multi-hop': { ...FLOOR_ONE } }
      }
    })

    expect(evaluateThresholds(res, entry)).toEqual([
      {
        scope: 'category:multi-hop',
        metric: 'present',
        actual: 0,
        threshold: 1,
        detail: 'category has no passing scenarios'
      }
    ])
  })

  test('a failed scenario assertion is always a regression', () => {
    const res = result({
      overall: { recall: 1, precision: 1, mrr: 1, hitRate: 1, queries: 1 },
      scenarios: [scenarioRun({ name: 'broken', status: 'fail', checkErrors: ['forbidden id x'] })]
    })

    expect(evaluateAssertions(res)).toEqual([
      {
        scope: 'scenario:broken',
        metric: 'assertion',
        actual: 0,
        threshold: 1,
        detail: 'forbidden id x'
      }
    ])
  })

  test('xfail scenarios never gate: their assertions are not evaluated', () => {
    const res = result({
      scenarios: [
        scenarioRun({
          name: 'known-gap',
          category: 'supersession',
          outcome: 'xfail',
          status: 'xfail',
          checkErrors: ['forbidden stale id']
        })
      ]
    })

    expect(evaluateAssertions(res)).toEqual([])
  })

  test('xpass scenarios never gate: their assertions are not evaluated', () => {
    const res = result({
      scenarios: [
        scenarioRun({ name: 'closed-gap', category: 'contradiction', outcome: 'xfail', status: 'xpass' })
      ]
    })

    expect(evaluateAssertions(res)).toEqual([])
  })

  test('xfail scenarios are excluded: their assertions and metrics never gate', () => {
    const res = result({
      overall: { recall: 1, precision: 1, mrr: 1, hitRate: 1, queries: 1 },
      categories: { 'explicit-fact': { recall: 1, precision: 1, mrr: 1, hitRate: 1, queries: 1 } },
      scenarios: [
        scenarioRun({ name: 'ok' }),
        scenarioRun({
          name: 'known-gap',
          category: 'supersession',
          outcome: 'xfail',
          status: 'xfail',
          metrics: { recall: 0, precision: 0, mrr: 0, hitRate: 0, queries: 1 },
          checkErrors: ['forbidden stale id']
        })
      ]
    })

    expect(evaluateThresholds(res, thresholdEntry())).toEqual([])
  })

  test('an xpass scenario does not gate either', () => {
    const res = result({
      overall: { recall: 1, precision: 1, mrr: 1, hitRate: 1, queries: 1 },
      scenarios: [
        scenarioRun({ name: 'closed-gap', category: 'contradiction', outcome: 'xfail', status: 'xpass' })
      ]
    })

    expect(evaluateThresholds(res, thresholdEntry())).toEqual([])
  })
})

describe('collectGatingRegressions', () => {
  test('mode without a baseline: a failing assertion still gates', () => {
    const res = result({
      scenarios: [scenarioRun({ name: 'broken', status: 'fail', checkErrors: ['forbidden id x'] })]
    })

    expect(collectGatingRegressions(res, null)).toEqual([
      {
        scope: 'scenario:broken',
        metric: 'assertion',
        actual: 0,
        threshold: 1,
        detail: 'forbidden id x'
      }
    ])
  })

  test('mode without a baseline: metric regressions do not gate', () => {
    const res = result({ overall: { recall: 0, precision: 0, mrr: 0, hitRate: 0, queries: 1 } })

    expect(collectGatingRegressions(res, null)).toEqual([])
  })

  test('mode with a baseline: metric regressions gate', () => {
    const res = result({ overall: { recall: 0.9, precision: 1, mrr: 1, hitRate: 1, queries: 1 } })

    expect(collectGatingRegressions(res, thresholdEntry())).toEqual([
      { scope: 'overall', metric: 'recall', actual: 0.9, threshold: 1 }
    ])
  })

  test('mode with a baseline: assertions are not duplicated', () => {
    const res = result({
      overall: { recall: 1, precision: 1, mrr: 1, hitRate: 1, queries: 1 },
      scenarios: [scenarioRun({ name: 'broken', status: 'fail', checkErrors: ['boom'] })]
    })

    expect(collectGatingRegressions(res, thresholdEntry())).toHaveLength(1)
  })

  test('mode with a baseline: assertion and metric regressions are both present, assertion once', () => {
    const res = result({
      overall: { recall: 0, precision: 0, mrr: 0, hitRate: 0, queries: 1 },
      scenarios: [
        scenarioRun({ name: 'broken', status: 'fail', checkErrors: ['boom'] }),
        scenarioRun({ name: 'also-broken', status: 'fail', checkErrors: ['bang'] })
      ]
    })

    const regressions = collectGatingRegressions(res, thresholdEntry())
    const assertions = regressions.filter(entry => entry.metric === 'assertion')

    expect(assertions).toEqual([
      {
        scope: 'scenario:broken',
        metric: 'assertion',
        actual: 0,
        threshold: 1,
        detail: 'boom'
      },
      {
        scope: 'scenario:also-broken',
        metric: 'assertion',
        actual: 0,
        threshold: 1,
        detail: 'bang'
      }
    ])
    // The default entry floor is 1, so every overall metric is below it too.
    expect(regressions.filter(entry => entry.metric !== 'assertion').map(entry => entry.metric)).toEqual([
      'recall',
      'precision',
      'mrr',
      'hitRate'
    ])
  })

  test('xfail assertion failures never gate, with or without a baseline', () => {
    const res = result({
      overall: { recall: 1, precision: 1, mrr: 1, hitRate: 1, queries: 1 },
      scenarios: [
        scenarioRun({
          name: 'known-gap',
          category: 'supersession',
          outcome: 'xfail',
          status: 'xfail',
          checkErrors: ['forbidden stale id']
        })
      ]
    })

    expect(collectGatingRegressions(res, null)).toEqual([])
    expect(collectGatingRegressions(res, thresholdEntry())).toEqual([])
  })

  test('xpass scenarios never contribute assertion regressions', () => {
    const res = result({
      overall: { recall: 1, precision: 1, mrr: 1, hitRate: 1, queries: 1 },
      scenarios: [
        scenarioRun({ name: 'closed-gap', category: 'contradiction', outcome: 'xfail', status: 'xpass' })
      ]
    })

    expect(collectGatingRegressions(res, null)).toEqual([])
    expect(collectGatingRegressions(res, thresholdEntry())).toEqual([])
  })
})

describe('threshold file helpers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-thresholds-'))

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('a missing file loads as null', () => {
    expect(loadThresholds(join(dir, 'missing.json'))).toBeNull()
  })

  test('invalid JSON loads as null', () => {
    const path = join(dir, 'invalid.json')
    writeFileSync(path, 'not json')

    expect(loadThresholds(path)).toBeNull()
  })

  test('write/load round-trips and upsert keeps other modes', () => {
    const path = join(dir, 'ok.json')
    const deterministic = thresholdEntry()
    const real: ThresholdEntry = { ...thresholdEntry(), mode: 'real' }

    const file = upsertThresholdEntry(
      upsertThresholdEntry({ version: 1, modes: {} }, deterministic),
      real
    )
    writeThresholds(path, file)

    expect(Object.keys(file.modes).sort()).toEqual(['deterministic', 'real'])
    expect(loadThresholds(path)).toEqual(file)
  })
})

describe('runEval end-to-end', () => {
  test('forbid failures mark pass scenarios fail; xfail scenarios stay xfail and out of aggregates', async () => {
    const scenarios: EvalScenario[] = [
      {
        name: 'clean',
        category: 'explicit-fact',
        description: 'single distinctive fact',
        thoughts: [{ id: 'only', content: 'distinctive zanzibar lighthouse fact' }],
        queries: [{ query: 'zanzibar lighthouse', relevant: ['only'] }]
      },
      {
        name: 'gap',
        category: 'supersession',
        description: 'duplicate facts where the forbidden one is always retrieved',
        outcome: 'xfail',
        thoughts: [
          { id: 'dup-a', content: 'identical duplicate content token' },
          { id: 'dup-b', content: 'identical duplicate content token' }
        ],
        queries: [
          { query: 'identical duplicate content token', relevant: ['dup-a'], forbid: ['dup-b'] }
        ]
      }
    ]

    const res = await runEval({ scenarios })

    const clean = res.scenarios.find(s => s.name === 'clean')
    const gap = res.scenarios.find(s => s.name === 'gap')
    expect(clean?.status).toBe('pass')
    expect(gap?.status).toBe('xfail')
    expect(gap?.checkErrors.length).toBeGreaterThan(0)
    // xfail is excluded from overall/category aggregates.
    expect(res.overall.queries).toBe(1)
    expect(res.categories.supersession).toBeUndefined()
    expect(res.categories['explicit-fact']?.queries).toBe(1)
  })
})
