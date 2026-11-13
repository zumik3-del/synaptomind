// F2 pin (tasks #2478 measurement, #2479 stopgap, #2480 test).
//
// The search layer derives one *global* candidate pool for both legs and applies
// the filter inside the vec0 query, after the KNN cutoff (`db/search-vector.ts`),
// so a project whose rows rank below the cutoff contributes nothing. #2478
// measured that loss; #2479 made a filtered search take the existing cap
// (`CANDIDATE_POOL_MAX`, 1000) while an unfiltered one keeps `topK × 10`. These
// tests pin the post-fix snapshot and the mechanism behind it:
//
//   - the partition-scoped vec0 leg reaches its project's answers at any pool,
//     while an unscoped leg stays pool-bound — the mechanism behind the fix;
//   - at the seeded corpus (900 nearer rows, under the cap) the default arms
//     recover the ground truth on the vector leg *and* on the user-facing hybrid
//     path, and the cap-wide leg returns only the queried project's rows;
//   - the control query keeps recall 1 and leads with its own answers, so the
//     filter, the pool plumbing and the harness are proven at the same width;
//   - an exhaustively short filtered result stays `degraded: false` (a small
//     project is not flagged just for being small);
//   - past the stopgap's cap (1 200 and 10 000 nearer rows) the default arms
//     still reach recall@5 = 1.000, with `degraded: false` (§8 acceptance).
//
// The corpus and the arms come from `multiproject-dilution.ts`, shared with the
// eval scenario; the overfetch arms are gone because a filtered search no longer
// narrows its pool.

import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb, initDb } from '../src/db'
import { buildFilterSQL, buildVecScopeSQL } from '../src/db/search-filters'
import type { SearchResult } from '../src/db/search-types'
import { vecSearchIds } from '../src/db/search-vector'
import { deterministicEmbedding } from './embedding'
import {
  buildMultiProjectDilutionScenario,
  DILUTION_CONTROL_RELEVANT,
  DILUTION_CORPUS,
  DILUTION_OVER_CAP_1200,
  DILUTION_OVER_CAP_CORPORA,
  DILUTION_PROJECTS,
  DILUTION_QUERY,
  DILUTION_RELEVANT,
  MULTI_PROJECT_DILUTION_SCENARIO
} from './multiproject-dilution'
import { runEval } from './runner'
import { seedScenario } from './seed'
import type { EvalScenario, QueryRun, RunResult } from './types'

function arm(result: RunResult, label: string): QueryRun {
  const query = result.scenarios[0]?.queries.find(run => run.label === label)
  if (!query) throw new Error(`arm "${label}" missing from the probe run`)
  return query
}

async function withSeededDb(
  fn: () => void | Promise<void>,
  scenario: EvalScenario = MULTI_PROJECT_DILUTION_SCENARIO
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'eval-pool-dilution-'))
  initDb({ dbPath: join(dir, 'db.sqlite'), runMigrations: true })
  try {
    await seedScenario(getDb(), scenario, text => deterministicEmbedding(text))
    await fn()
  } finally {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Service-level search in the shape the probe uses: vector leg, no gate. */
async function searchWithSignal(
  topK: number,
  query = DILUTION_QUERY
): Promise<SearchResult[] & { degraded?: boolean }> {
  const { searchThoughts } = await import('../src/services/search.service')
  return (await searchThoughts({
    query,
    topK,
    projectFilter: DILUTION_PROJECTS.small,
    hybrid: false,
    supersessionMode: 'suppress',
    minRelevance: 0,
    embedding: deterministicEmbedding(query)
  })) as SearchResult[] & { degraded?: boolean }
}

describe('pool-dilution probe corpus', () => {
  test('three deliberately unequal projects, ground truth only in the smallest', () => {
    const scenario = MULTI_PROJECT_DILUTION_SCENARIO
    const sizes = new Map<string, number>()
    for (const thought of scenario.thoughts) {
      const project = thought.projectId ?? 'default'
      sizes.set(project, (sizes.get(project) ?? 0) + 1)
    }

    expect([...sizes.keys()].sort()).toEqual(
      [DILUTION_PROJECTS.big, DILUTION_PROJECTS.mid, DILUTION_PROJECTS.small].sort()
    )
    const ordered = [...sizes.values()].sort((a, b) => b - a)
    expect(ordered[0]).toBeGreaterThan(ordered[1])
    expect(ordered[1]).toBeGreaterThan(ordered[2])

    // The smallest project also holds the fewest rows and every labelled answer.
    const smallest = [...sizes.entries()].sort((a, b) => a[1] - b[1])[0]
    expect(smallest[0]).toBe(DILUTION_PROJECTS.small)
    const relevantProjects = new Set(
      scenario.thoughts
        .filter(thought =>
          [...DILUTION_RELEVANT, ...DILUTION_CONTROL_RELEVANT].includes(thought.id)
        )
        .map(thought => thought.projectId)
    )
    expect([...relevantProjects]).toEqual([DILUTION_PROJECTS.small])
  })

  test('every arm keeps the query, the filter and the scored k comparable', () => {
    const scenario = MULTI_PROJECT_DILUTION_SCENARIO
    const diluted = scenario.queries.filter(query => query.query === DILUTION_QUERY)

    // Three arms: the harness k on hybrid and on the raw vector leg, plus the
    // production default k. A pool knob cannot narrow a filtered search any
    // more, so no arm carries one.
    expect(diluted.map(query => query.label)).toEqual([
      'hybrid-k5',
      'vector-k5',
      'hybrid-k10',
      'vector-k10'
    ])
    for (const query of diluted) {
      expect(query.projectFilter).toBe(DILUTION_PROJECTS.small)
      expect(query.relevant).toEqual(DILUTION_RELEVANT)
      expect(query.topK ?? 5).toBe((query.label ?? '').endsWith('-k10') ? 10 : 5)
      expect(query.poolTopK).toBeUndefined()
    }

    const control = scenario.queries.filter(query => query.query !== DILUTION_QUERY)
    expect(control.length).toBe(2)
    for (const query of control) {
      expect(query.relevant).toEqual(DILUTION_CONTROL_RELEVANT)
      expect(query.poolTopK).toBeUndefined()
    }
  })
})

describe('pool-dilution arms (deterministic embedder)', () => {
  let result: RunResult

  beforeAll(async () => {
    result = await runEval({ scenarios: [MULTI_PROJECT_DILUTION_SCENARIO] })
  })

  test('the probe is measure-only: it contributes no queries to the gated aggregates', () => {
    expect(result.scenarios[0].measureOnly).toBe(true)
    expect(result.overall.queries).toBe(0)
    expect(result.categories['pool-dilution']).toBeUndefined()
  })

  test('the default arms recover the ground truth on the vector leg and on hybrid', () => {
    // 900 rows rank nearer than the ground truth. The scoped leg ranks inside
    // the queried project, so the foreign rows no longer set the reach: #2478
    // measured 0.000 here pre-fix, 1.000 from the stopgap on, and the projection
    // keeps it at 1.000 for corpora far past the cap below.
    for (const label of ['hybrid-k5', 'vector-k5', 'hybrid-k10', 'vector-k10']) {
      expect(arm(result, label).metrics.recall, label).toBe(1)
    }
    expect(arm(result, 'vector-k5').metrics.retrieved).toEqual(
      expect.arrayContaining(DILUTION_RELEVANT)
    )
    // k=10 is the production default: its pre-fix pool was 400, now the cap.
    expect(arm(result, 'vector-k10').metrics.retrieved.length).toBeLessThanOrEqual(10)
  })

  test('the control query keeps full recall and leads with its own answers', () => {
    // The answers are the globally nearest rows, so the filter, the pool
    // plumbing and the harness are all proven at the same cap-wide pool.
    for (const label of ['vector-k5-control', 'hybrid-k5-control']) {
      const query = arm(result, label)
      expect(query.metrics.recall, label).toBe(1)
      expect(query.metrics.retrieved.slice(0, DILUTION_CONTROL_RELEVANT.length), label).toEqual(
        [...DILUTION_CONTROL_RELEVANT].reverse()
      )
    }
  })
})

describe('pool-dilution mechanism (raw vec0 leg)', () => {
  let nearer = 0

  beforeAll(() => {
    nearer = DILUTION_CORPUS.big + DILUTION_CORPUS.mid
  })

  test('the partition-scoped leg ranks inside the project at any pool', async () => {
    await withSeededDb(() => {
      const embedding = deterministicEmbedding(DILUTION_QUERY)
      const filter = buildFilterSQL(getDb(), { projectFilter: DILUTION_PROJECTS.small })
      const scope = buildVecScopeSQL({ projectFilter: DILUTION_PROJECTS.small })
      const scoped = (pool: number) =>
        vecSearchIds(getDb(), embedding, pool, scope, filter, 200, true)
      const unscoped = (pool: number) =>
        vecSearchIds(getDb(), embedding, pool, { sql: '', params: [] }, filter, 200, true)

      // Without the partition fragment the leg is still pool-bound: the 900
      // globally nearer foreign rows fill the pool before the post-filter runs,
      // which is the pre-fix defect (#2478).
      expect(unscoped(nearer)).toHaveLength(0)

      // With it, the KNN ranks inside the addressed partition (plus globals), so
      // the same pool reaches the project's rows…
      const reached = scoped(nearer)
      expect(reached).toHaveLength(5)
      // …and even a project-sized pool is enough: foreign rows never consume it.
      expect(scoped(5)).toHaveLength(5)

      // Nothing foreign leaks in.
      const projectOf = getDb().prepare('SELECT project_id FROM thoughts WHERE id = ?')
      for (const id of reached.map(row => row.id)) {
        expect((projectOf.get(id) as { project_id: string }).project_id).toBe(
          DILUTION_PROJECTS.small
        )
      }
    })
  })
})

describe('pool-dilution acceptance (past the stopgap cap)', () => {
  test('recall@5 is 1.000 at 1 200 and 10 000 globally nearer rows', async () => {
    for (const { label, sizes } of DILUTION_OVER_CAP_CORPORA) {
      const scenario = buildMultiProjectDilutionScenario({
        name: `multi-project-pool-dilution-over-cap-${label}`,
        ...sizes
      })
      const result = await runEval({ scenarios: [scenario] })
      // The production default k on both legs: the structural fix must hold past
      // the cap, where the stopgap's cap-wide global pool could not reach.
      for (const armLabel of ['hybrid-k10', 'vector-k10']) {
        expect(arm(result, armLabel).metrics.recall, `${label}/${armLabel}`).toBe(1)
      }
    }
  }, 180_000)

  test('a corpus past the cap is not reported as degraded', async () => {
    const scenario = buildMultiProjectDilutionScenario({
      name: 'multi-project-pool-dilution-over-cap-degraded',
      ...DILUTION_OVER_CAP_1200
    })
    await withSeededDb(async () => {
      const items = await searchWithSignal(10)
      // The answers are now reachable, so a short-looking project is complete
      // truth and the leg must not claim starvation.
      expect(items).toHaveLength(5)
      expect(items.degraded).toBe(false)
    }, scenario)
  })
})
