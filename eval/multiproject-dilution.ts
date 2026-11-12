// F2 probe (task #2478): multi-project dilution of the filtered vector leg.
//
// `db/search.ts` derives ONE global candidate pool for both legs
// (`topK × 10`, capped at 1000 — `db/search.ts:15-16,29`) and the vec0 leg
// applies the project/status/cluster filter to that pool afterwards inside the
// same query (`db/search-vector.ts:28-39`: `v.embedding MATCH ? AND v.k = ?`
// with the filter fragment in the WHERE clause). Rows of the requested project
// that rank below the pool cutoff never reach the filter, so a narrow project on
// a large database can contribute nothing to the vector leg — silently, with no
// `degraded` flag on the outcome.
//
// The corpus is a deliberate size gradient (fleet > depot > lighthouse) in which
// every row of the two larger projects sits closer to the query than any row of
// the smallest one, so the ranked neighbourhood is dominated by projects the
// query does not ask for while the ground truth lives in the smallest project.
//
// The arms exist to isolate the cause, all against the same seeded corpus:
//   - `hybrid-k5` vs `vector-k5` differ only in the search legs, so a loss that
//     shows up in both is not an RRF artifact;
//   - `vector-k5-pool1000` keeps the query, the filter and the scored k and
//     changes only the overfetch (`poolTopK`), so a recovery there attributes the
//     loss to the pool width — and `vector-k5-pool520` sits below the number of
//     globally nearer rows, which brackets where the loss starts;
//   - `hybrid-k5-pool1000` asks whether widening recovers the user-facing path
//     too (the BM25 leg has its own overfetch, `db/search-bm25.ts:84-105`, so it
//     can mask the vector loss at smaller corpora — see the BM25-mask case in
//     `multiproject-dilution.test.ts`);
//   - the `*-control` arms repeat the narrow-pool calls on a query whose answers
//     are the globally nearest rows, so a zero from the diluted arms cannot be
//     blamed on the filter, on the pool plumbing or on the harness;
//   - `vector-k10` shows the k dependence, since a larger k also widens the
//     derived pool.

import type { EvalQuery, EvalScenario, EvalThought } from './types'

export const DILUTION_QUERY = 'brass lantern wick trim schedule'
export const DILUTION_CONTROL_QUERY = 'harbour foghorn interval'

export const DILUTION_PROJECTS = {
  big: 'fleet',
  mid: 'depot',
  small: 'lighthouse'
} as const

export const DILUTION_RELEVANT = ['lh-target-0', 'lh-target-1', 'lh-target-2']
export const DILUTION_CONTROL_RELEVANT = ['lh-control-0', 'lh-control-1']

export interface DilutionCorpusSizes {
  /** Rows in the largest project; each one ranks nearer than any ground truth. */
  big?: number
  /** Rows in the middle project; each one also ranks nearer than any ground truth. */
  mid?: number
}

/**
 * Default corpus: 900 rows rank nearer than the ground truth and the queried
 * project holds 5, which puts the ground truth past both the default vector pool
 * (200) and the default BM25 overfetch (600) — the production shape.
 */
export const DILUTION_CORPUS: Required<DilutionCorpusSizes> = { big: 700, mid: 200 }

// Short notes that repeat the query's topic terms: they occupy the near end of
// the ranked neighbourhood under both embedders (measured: real-embedder
// similarity 0.924-0.935 against the ground truth's 0.897-0.900) without being
// the facts under test.
function fleetRow(index: number): string {
  return `Brass lantern wick trim schedule — dock crew note ${index}.`
}

// Same shape, different site note: still nearer than the ground truth, so the
// two larger projects together fill the pool ahead of the queried one.
function depotRow(index: number): string {
  return `Brass lantern wick trim schedule — quay duty note ${index}.`
}

// Long, specific facts. They carry the query topic but the qualifying detail
// lowers their similarity below the short generic notes above.
function targetRow(index: number): string {
  return (
    `The brass lantern wick trim schedule for the northern lighthouse is kept ` +
    `in logbook ${index} of the autumn inspection round.`
  )
}

// Second topic inside the same (smallest) project: the control query's answers
// are the globally nearest rows, so the narrow pool must reach them.
function controlRow(index: number): string {
  return `The harbour foghorn interval is verified by the night watch on tide ${index}.`
}

function corpus(sizes: Required<DilutionCorpusSizes>): EvalThought[] {
  const thoughts: EvalThought[] = []
  for (let i = 0; i < sizes.big; i++) {
    thoughts.push({ id: `fleet-${i}`, content: fleetRow(i), projectId: DILUTION_PROJECTS.big })
  }
  for (let i = 0; i < sizes.mid; i++) {
    thoughts.push({ id: `depot-${i}`, content: depotRow(i), projectId: DILUTION_PROJECTS.mid })
  }
  for (let i = 0; i < DILUTION_RELEVANT.length; i++) {
    thoughts.push({
      id: DILUTION_RELEVANT[i],
      content: targetRow(i),
      projectId: DILUTION_PROJECTS.small
    })
  }
  for (let i = 0; i < DILUTION_CONTROL_RELEVANT.length; i++) {
    thoughts.push({
      id: DILUTION_CONTROL_RELEVANT[i],
      content: controlRow(i),
      projectId: DILUTION_PROJECTS.small
    })
  }
  return thoughts
}

// The diluted query, searched in the smallest project. `hybrid`/`poolTopK` are
// the only knobs that move between arms; everything else is held constant.
function dilutedQueries(): EvalQuery[] {
  const diluted = {
    query: DILUTION_QUERY,
    relevant: [...DILUTION_RELEVANT],
    projectFilter: DILUTION_PROJECTS.small
  }
  const control = {
    query: DILUTION_CONTROL_QUERY,
    relevant: [...DILUTION_CONTROL_RELEVANT],
    projectFilter: DILUTION_PROJECTS.small
  }
  return [
    // Default pool (k=5 -> candidate pool 200): hybrid is the user-facing path.
    { ...diluted, label: 'hybrid-k5' },
    // Same pool, vector leg only: no BM25, no RRF.
    { ...diluted, label: 'vector-k5', hybrid: false },
    // k=10 also widens the derived pool (400) while the scored k grows.
    { ...diluted, label: 'vector-k10', hybrid: false, topK: 10 },
    // Pool 520 = still below the 900 rows that rank nearer than the ground truth.
    { ...diluted, label: 'vector-k5-pool520', hybrid: false, poolTopK: 13 },
    // Pool at its 1000 cap: above the nearer rows, so the filter finally sees them.
    { ...diluted, label: 'vector-k5-pool1000', hybrid: false, poolTopK: 50 },
    // Does widening recover the user-facing (hybrid) path as well?
    { ...diluted, label: 'hybrid-k5-pool1000', poolTopK: 50 },
    // Control arms: same narrow pool, a query whose answers are globally nearest.
    { ...control, label: 'vector-k5-control', hybrid: false },
    { ...control, label: 'hybrid-k5-control' }
  ]
}

export interface DilutionScenarioOptions extends DilutionCorpusSizes {
  /** Scenario name; defaults to `multi-project-pool-dilution`. */
  name?: string
}

export function buildMultiProjectDilutionScenario(
  options: DilutionScenarioOptions = {}
): EvalScenario {
  const sizes: Required<DilutionCorpusSizes> = { ...DILUTION_CORPUS, ...options }
  return {
    name: options.name ?? 'multi-project-pool-dilution',
    category: 'pool-dilution',
    description:
      'The filtered vec0 leg draws from a global candidate pool: a query whose ground truth lives in the smallest of three unequal projects loses recall when the pool is narrower than the number of globally nearer rows.',
    // A probe, not a retrieval floor: its recall is the F2 measurement, so it
    // must never enter the aggregates or the recorded thresholds.
    measureOnly: true,
    thoughts: corpus(sizes),
    queries: dilutedQueries()
  }
}

export const MULTI_PROJECT_DILUTION_SCENARIO = buildMultiProjectDilutionScenario()
