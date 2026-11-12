// F2 measurement (task #2478): multi-project dilution of the filtered vector leg.
//
// `db/search.ts` derives one *global* candidate pool (`topK × 10`, capped at
// 1000) and the vec0 leg filters that pool afterwards (`db/search-vector.ts`),
// so a project whose rows rank below the cutoff contributes nothing — silently.
// These tests pin the instrument and the measurement:
//
//   - the raw vec0 leg returns nothing until the pool passes the number of
//     globally nearer rows, which is the mechanism in one assertion;
//   - at the seeded corpus the default pool loses the ground truth on the vector
//     leg *and* on the user-facing hybrid path, while a wider pool recovers both
//     with the same query, filter and scored k;
//   - the control query (answers are the globally nearest rows) keeps recall 1 at
//     the same narrow pool, so the zeros are not the filter or the harness;
//   - a corpus smaller than the BM25 leg's overfetch masks the loss on the hybrid
//     path, which is why the default corpus is sized above it.
//
// The zero-recall assertions are a snapshot of the pre-fix behaviour: when F2 is
// fixed the narrow arms recover, so flip them to 1 together with the F2 entry in
// `multiproject-dilution.ts` and `docs/EVAL.md`.

import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb, initDb } from '../src/db'
import { buildFilterSQL } from '../src/db/search-filters'
import type { SearchResult } from '../src/db/search-types'
import { vecSearchIds } from '../src/db/search-vector'
import { deterministicEmbedding } from './embedding'
import {
  buildMultiProjectDilutionScenario,
  DILUTION_CONTROL_RELEVANT,
  DILUTION_CORPUS,
  DILUTION_PROJECTS,
  DILUTION_QUERY,
  DILUTION_RELEVANT,
  MULTI_PROJECT_DILUTION_SCENARIO
} from './multiproject-dilution'
import { runEval } from './runner'
import { seedScenario } from './seed'
import type { QueryRun, RunResult } from './types'

function arm(result: RunResult, label: string): QueryRun {
  const query = result.scenarios[0]?.queries.find(run => run.label === label)
  if (!query) throw new Error(`arm "${label}" missing from the probe run`)
  return query
}

async function withSeededDb(fn: () => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'eval-pool-dilution-'))
  initDb({ dbPath: join(dir, 'db.sqlite'), runMigrations: true })
  try {
    await seedScenario(getDb(), MULTI_PROJECT_DILUTION_SCENARIO, text =>
      deterministicEmbedding(text)
    )
    await fn()
  } finally {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  }
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

    expect(diluted.length).toBe(6)
    for (const query of diluted) {
      expect(query.projectFilter).toBe(DILUTION_PROJECTS.small)
      expect(query.relevant).toEqual(DILUTION_RELEVANT)
      expect(query.topK ?? 5).toBe(query.label === 'vector-k10' ? 10 : 5)
    }

    const control = scenario.queries.filter(query => query.query !== DILUTION_QUERY)
    expect(control.length).toBe(2)
    for (const query of control) expect(query.relevant).toEqual(DILUTION_CONTROL_RELEVANT)
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

  test('the default pool loses the ground truth on the vector leg and on hybrid', () => {
    // Both legs lose: the loss is not an RRF artifact, and it reaches the
    // user-facing hybrid path, not just the vector-only call.
    expect(arm(result, 'hybrid-k5').metrics.recall).toBe(0)
    expect(arm(result, 'vector-k5').metrics.recall).toBe(0)
    expect(arm(result, 'vector-k5').metrics.retrieved).toEqual([])
    // k=10 widens the derived pool too (400) and still misses.
    expect(arm(result, 'vector-k10').metrics.recall).toBe(0)
    // Pool 520 is still narrower than the number of globally nearer rows.
    expect(arm(result, 'vector-k5-pool520').metrics.recall).toBe(0)
  })

  test('a wider pool recovers both paths with the filter and the scored k unchanged', () => {
    for (const label of ['vector-k5-pool1000', 'hybrid-k5-pool1000']) {
      const query = arm(result, label)
      expect(query.metrics.recall, label).toBe(1)
      // The overfetch is truncated back to the scored k before metrics.
      expect(query.metrics.retrieved.length, label).toBeLessThanOrEqual(5)
      expect(query.poolTopK, label).toBe(50)
    }
  })

  test('the control query keeps full recall at the same narrow pool', () => {
    // The answers are the globally nearest rows, so the filter, the pool
    // plumbing and the harness are all proven for this project and this k.
    expect(arm(result, 'vector-k5-control').metrics.recall).toBe(1)
    expect(arm(result, 'hybrid-k5-control').metrics.recall).toBe(1)
    expect(arm(result, 'vector-k5-control').metrics.retrieved).toEqual(
      [...DILUTION_CONTROL_RELEVANT].reverse()
    )
  })
})

describe('pool-dilution mechanism (raw vec0 leg)', () => {
  let nearer = 0

  beforeAll(() => {
    nearer = DILUTION_CORPUS.big + DILUTION_CORPUS.mid
  })

  test('the filtered leg returns nothing until the pool passes the nearer-row count', async () => {
    await withSeededDb(() => {
      const embedding = deterministicEmbedding(DILUTION_QUERY)
      const { sql, params } = buildFilterSQL({ projectFilter: DILUTION_PROJECTS.small })
      const rows = (pool: number) => vecSearchIds(getDb(), embedding, pool, sql, params, 200, true)

      // The pool is filled entirely by the two larger projects right up to the
      // point where it reaches the queried project's rows.
      expect(rows(nearer)).toHaveLength(0)
      expect(rows(nearer + 1).map(row => row.id)).toEqual(['lh-target-2'])
      expect(rows(1000)).toHaveLength(5)
    })
  })

  test('the loss is silent: no degraded flag and an empty result, not an error', async () => {
    await withSeededDb(async () => {
      const { searchThoughts } = await import('../src/services/search.service')
      const items = await searchThoughts({
        query: DILUTION_QUERY,
        topK: 5,
        projectFilter: DILUTION_PROJECTS.small,
        hybrid: false,
        supersessionMode: 'suppress',
        minRelevance: 0,
        embedding: deterministicEmbedding(DILUTION_QUERY)
      })

      // The service attaches the collection-level flag to the result array; an
      // empty filtered leg is indistinguishable from "this project has no
      // match", which is why the loss needs a probe like this one to be seen.
      expect(items).toEqual([])
      expect((items as SearchResult[] & { degraded?: boolean }).degraded).toBe(false)
    })
  })
})

describe('pool-dilution masking at a smaller corpus', () => {
  test('inside the BM25 overfetch the hybrid path is masked while the vector leg still loses', async () => {
    const small = buildMultiProjectDilutionScenario({
      name: 'multi-project-pool-dilution-small',
      big: 300,
      mid: 100
    })
    const result = await runEval({ scenarios: [small] })

    // 400 rows rank nearer than the ground truth: the default vector pool (200)
    // still misses, while a pool above 400 recovers. The hybrid path is masked
    // because the BM25 leg overfetches 600 rows, which covers this corpus — the
    // default corpus in `multiproject-dilution.ts` is sized above it.
    expect(arm(result, 'vector-k5').metrics.recall).toBe(0)
    expect(arm(result, 'hybrid-k5').metrics.recall).toBe(1)
    expect(arm(result, 'vector-k5-pool520').metrics.recall).toBe(1)
  })
})
