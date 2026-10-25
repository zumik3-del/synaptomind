// Evaluation runner: seeds scenarios, executes their queries through the
// injected searcher, scores results, and aggregates the run.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb, initDb } from '../src/db'
import { EVAL_SCENARIOS } from './datasets'
import { averageMetrics, computeQueryMetrics } from './metrics'
import { seedScenario } from './seed'
import {
  createDeterministicOutcomeSearcher,
  deterministicEmbedder,
  HARNESS_MIN_RELEVANCE,
  realEmbedder,
  realOutcomeSearcher,
  resolveDefaultMinRelevance
} from './search'
import type {
  AggregateMetrics,
  EvalMode,
  EvalQuery,
  EvalScenario,
  GateStats,
  QueryMetrics,
  RelevanceGate,
  RetrievedHit,
  RunResult
} from './types'
export type { EvalMode, RunResult } from './types'

export const DEFAULT_TOP_K = 5

import type { QueryRun, ScenarioRun } from './types'
export { buildThresholdEntry, collectGatingRegressions, evaluateAssertions, evaluateThresholds, loadThresholds, upsertThresholdEntry, writeThresholds } from './thresholds'
export type { MetricFloor, ThresholdEntry, ThresholdFile } from './thresholds'
export type { QueryRun, ScenarioRun } from './types'
export type { GateStats, RelevanceGate } from './types'

interface RunOptions {
  mode?: EvalMode
  topK?: number
  scenarios?: EvalScenario[]
  /**
   * Relevance gate for this pass: `off` (default, pinned `minRelevance: 0`, the
   * pass the recorded baselines and the exit code gate on) or `default` (the
   * production gate, report-only — see `runEvalWithGate`).
   */
  gate?: RelevanceGate
}

/**
 * A full harness run with both relevance-gate passes over the same scenarios.
 *
 * `gated` is **report-only** (task #2191): it never feeds thresholds, the
 * regression list or the exit code, it only makes the production gate's recall
 * cost visible next to the ungated measurement.
 */
export interface EvalPasses {
  /** Ungated pass (`minRelevance: 0`); the one thresholds and the exit code gate on. */
  ungated: RunResult
  /** Report-only pass with the gate production resolves. */
  gated: RunResult
}

/**
 * Hard per-query assertions. `scenarioThoughtIds` are the scenario's own
 * (non-distractor) thought ids, used only by the `noRelevant` contract.
 * `hits` carries the per-result confidence signals needed by
 * `expectNoStrongMatch`; when the query requests that contract every retrieved
 * id MUST have a matching hit so the assertion cannot pass vacuously.
 */
export function evaluateChecks(
  query: EvalQuery,
  retrieved: string[],
  scenarioThoughtIds: string[] = [],
  hits: RetrievedHit[] = []
): string[] {
  const errors: string[] = []
  const found = new Set(retrieved)
  for (const id of query.forbid ?? []) {
    if (found.has(id)) errors.push(`retrieved forbidden thought "${id}"`)
  }
  if (query.noRelevant) {
    for (const id of scenarioThoughtIds) {
      if (found.has(id)) errors.push(`noRelevant query retrieved scenario thought "${id}"`)
    }
  }
  if (query.expectNoStrongMatch) {
    const byId = new Map(hits.map(hit => [hit.id, hit]))
    for (const id of retrieved) {
      const hit = byId.get(id)
      if (!hit) {
        errors.push(`expectNoStrongMatch query is missing confidence for retrieved thought "${id}"`)
      } else if (!hit.lowConfidence) {
        errors.push(`expectNoStrongMatch query retrieved strong match "${id}"`)
      }
    }
  }
  if (query.rankBefore) {
    const beforeIndex = retrieved.indexOf(query.rankBefore.before)
    const afterIndex = retrieved.indexOf(query.rankBefore.after)
    if (beforeIndex === -1) {
      errors.push(
        `expected "${query.rankBefore.before}" to rank before "${query.rankBefore.after}" but it was not retrieved`
      )
    } else if (afterIndex !== -1 && beforeIndex > afterIndex) {
      errors.push(`"${query.rankBefore.before}" ranked below "${query.rankBefore.after}"`)
    }
  }
  return errors
}

export function summariseScenario(scenario: EvalScenario, queries: QueryRun[]): ScenarioRun {
  const checkErrors = queries.flatMap(query => query.metrics.checkErrors)
  const xfail = scenario.outcome === 'xfail'
  let status: ScenarioRun['status']
  if (xfail) status = checkErrors.length > 0 ? 'xfail' : 'xpass'
  else status = checkErrors.length > 0 ? 'fail' : 'pass'

  return {
    name: scenario.name,
    category: scenario.category,
    outcome: xfail ? 'xfail' : 'pass',
    status,
    measureOnly: scenario.measureOnly === true,
    metrics: averageMetrics(queries.map(query => query.metrics)),
    queries,
    checkErrors
  }
}

export async function runEval(options: RunOptions = {}): Promise<RunResult> {
  const mode = options.mode ?? 'deterministic'
  const topK = options.topK ?? DEFAULT_TOP_K
  const scenarios = options.scenarios ?? EVAL_SCENARIOS
  const gate = options.gate ?? 'off'
  const dir = mkdtempSync(join(tmpdir(), 'synaptomind-eval-'))
  const embed = mode === 'real' ? await realEmbedder() : deterministicEmbedder()
  const results: ScenarioRun[] = []
  const gateStats: GateStats = {
    minRelevance: gate === 'default' ? await resolveDefaultMinRelevance() : HARNESS_MIN_RELEVANCE,
    candidates: 0,
    droppedRows: 0,
    queriesWithDrops: 0
  }

  try {
    for (const scenario of scenarios) {
      const safeName = scenario.name.replace(/[^a-zA-Z0-9-]/g, '_')
      closeDb()
      initDb({ dbPath: join(dir, `${safeName}.db`), runMigrations: true })
      const db = getDb()
      await seedScenario(db, scenario, embed)
      const searcher =
        mode === 'real'
          ? await realOutcomeSearcher(gate)
          : createDeterministicOutcomeSearcher(undefined, gate)
      // The scenario's own thoughts exclude shared DISTRACTORS; the noRelevant
      // contract asserts none of these are retrieved.
      const ownThoughtIds = scenario.thoughts
        .filter(thought => thought.distractor !== true)
        .map(thought => thought.id)

      const queries: QueryRun[] = []
      for (const query of scenario.queries) {
        const k = query.topK ?? topK
        const { hits: found, filteredOut } = await searcher(
          query.query,
          k,
          query.projectFilter,
          {
            recencyWeight: query.recencyWeight,
            recencyHalfLifeDays: query.recencyHalfLifeDays
          }
        )
        // Capture the #155 confidence signals before the ids are flattened, so
        // `expectNoStrongMatch` can assert on them (see eval/types.ts).
        const hits: RetrievedHit[] = found.map(result => ({
          id: result.thought.id,
          lowConfidence: result.low_confidence,
          similarity: result.similarity ?? 0,
          matchSource: result.match_source
        }))
        const retrieved = hits.map(hit => hit.id)
        gateStats.candidates += retrieved.length + filteredOut
        gateStats.droppedRows += filteredOut
        if (filteredOut > 0) gateStats.queriesWithDrops += 1
        const checkErrors = evaluateChecks(query, retrieved, ownThoughtIds, hits)
        queries.push({
          query: query.query,
          relevant: query.relevant,
          hits,
          metrics: computeQueryMetrics(retrieved, query.relevant, checkErrors)
        })
      }
      results.push(summariseScenario(scenario, queries))
    }
  } finally {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  }

  // xfail scenarios and measure-only feature probes are reported but excluded
  // from aggregate gating (measure-only assertions still gate via
  // `evaluateAssertions`).
  const passScenarios = results.filter(
    scenario => scenario.outcome === 'pass' && !scenario.measureOnly
  )
  const byCategory = new Map<string, QueryMetrics[]>()
  for (const scenario of passScenarios) {
    const bucket = byCategory.get(scenario.category) ?? []
    bucket.push(...scenario.queries.map(query => query.metrics))
    byCategory.set(scenario.category, bucket)
  }
  const categories: Record<string, AggregateMetrics> = {}
  for (const [category, metrics] of byCategory) categories[category] = averageMetrics(metrics)

  return {
    mode,
    generatedAt: new Date().toISOString(),
    topK,
    scenarios: results,
    overall: averageMetrics(passScenarios.flatMap(scenario => scenario.queries.map(query => query.metrics))),
    categories,
    relevanceGate: gateStats
  }
}

/**
 * Run the ungated (gating) pass and, over the same scenarios, the report-only
 * pass with the relevance gate production resolves. The gated pass is
 * deliberately not folded into `regressions` or the exit code (task #2191).
 */
export async function runEvalWithGate(options: RunOptions = {}): Promise<EvalPasses> {
  const ungated = await runEval({ ...options, gate: 'off' })
  const gated = await runEval({ ...options, gate: 'default' })
  return { ungated, gated }
}
