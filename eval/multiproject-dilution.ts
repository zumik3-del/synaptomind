// F2 probe (tasks #2478 measurement, #2479 stopgap).
//
// `db/search.ts` derives ONE candidate pool for both legs and applies the
// project/status/cluster filter to it afterwards inside the vec0 query
// (`db/search-vector.ts`: `v.embedding MATCH ? AND v.k = ?` with the filter
// fragment in the WHERE clause). Rows of the requested project that rank below
// the cutoff never reach the filter, so a narrow project on a large database can
// contribute nothing — silently, with no `degraded` flag on the outcome.
//
// #2478 measured that on this corpus: with 900 rows ranking nearer than the
// ground truth the topK-derived default pool (400 at production k=10) scored
// recall@5 = 0.000 on both the vector leg and hybrid, `degraded === false`, while
// a pool past 900 recovered both. The #2479 stopgap therefore pins a filtered
// search to the existing cap (`CANDIDATE_POOL_MAX`), so the default arms below
// now score 1.000; the raw-leg threshold (pool `nearer` -> 0 rows, `nearer + 1`
// -> 1, cap -> 5) stays pinned in `multiproject-dilution.test.ts`, since the
// search layer can no longer ask for a narrow filtered pool.
//
// The arms stay comparable across the fix: the same query, filter and corpus,
// differing only in the search legs and the scored k.
//   - `hybrid-k5` vs `vector-k5` differ only in the search legs, so a loss that
//     shows up in both is not an RRF artifact;
//   - `vector-k10` is the production default k, whose pre-fix pool was 400 and
//     whose post-fix pool is the cap;
//   - the `*-control` arms repeat the narrow-project calls on a query whose
//     answers are the globally nearest rows, so a zero from the diluted arms
//     cannot be blamed on the filter, on the pool plumbing or on the harness.
//
// Residual, measured and not fixed here: past the cap (more than 1000 nearer
// foreign rows) the loss returns, and that is when the response must carry
// `degraded = true` instead of an empty list. Scoping the vec0 leg by project
// (a partition/metadata column) is the structural fix, not part of the stopgap.

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
 * project holds 5 — the pre-fix shape where the topK-derived vector pool (200 at
 * k=5) starves the filter, and still under the 1000 cap so the stopgap's
 * cap-wide filtered pool reaches the answers.
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

// The diluted query, searched in the smallest project. `hybrid`/`topK` are the
// only knobs that move between arms; everything else is held constant. The
// overfetch knob (`poolTopK`) is gone: a filtered search takes the cap, so it
// could no longer narrow the pool the fix is measured on.
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
    // User-facing path at the harness k.
    { ...diluted, label: 'hybrid-k5' },
    // Same corpus, vector leg only: no BM25, no RRF.
    { ...diluted, label: 'vector-k5', hybrid: false },
    // The production default k; its pre-fix pool was 400, now the cap.
    { ...diluted, label: 'vector-k10', hybrid: false, topK: 10 },
    // Control arms: a query whose answers are globally nearest.
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
      'The filtered vec0 leg draws from a global candidate pool: a query whose ground truth lives in the smallest of three unequal projects recovers only when the pool is wider than the number of globally nearer rows (#2478). The stopgap pins a filtered pool to the cap, so these arms now recover; the raw-leg threshold stays pinned in the test.',
    // A probe, not a retrieval floor: its recall is the F2 measurement, so it
    // must never enter the aggregates or the recorded thresholds.
    measureOnly: true,
    thoughts: corpus(sizes),
    queries: dilutedQueries()
  }
}

export const MULTI_PROJECT_DILUTION_SCENARIO = buildMultiProjectDilutionScenario()
