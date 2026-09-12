// Evaluation runner: seeds each scenario into an isolated file-backed DB,
// executes its queries through the injected searcher, scores the results and
// aggregates them. Also owns the baseline/threshold file logic.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb, initDb } from '../src/db'
import { EVAL_SCENARIOS } from './datasets'
import { averageMetrics, computeQueryMetrics } from './metrics'
import { seedScenario } from './seed'
import {
  createDeterministicSearcher,
  deterministicEmbedder,
  realEmbedder,
  realSearcher
} from './search'
import type { AggregateMetrics, EvalQuery, EvalScenario, QueryMetrics } from './types'

export const DEFAULT_TOP_K = 5
export type EvalMode = 'deterministic' | 'real'

export interface QueryRun {
  query: string
  relevant: string[]
  metrics: QueryMetrics
}

export interface ScenarioRun {
  name: string
  category: string
  outcome: 'pass' | 'xfail'
  status: 'pass' | 'fail' | 'xfail' | 'xpass'
  metrics: AggregateMetrics
  queries: QueryRun[]
  checkErrors: string[]
}

export interface Regression {
  scope: string
  metric: string
  actual: number
  threshold: number
  detail?: string
}

export interface RunResult {
  mode: EvalMode
  generatedAt: string
  topK: number
  scenarios: ScenarioRun[]
  overall: AggregateMetrics
  categories: Record<string, AggregateMetrics>
}

export interface RunOptions {
  mode?: EvalMode
  topK?: number
  scenarios?: EvalScenario[]
}

export function evaluateChecks(query: EvalQuery, retrieved: string[]): string[] {
  const errors: string[] = []
  const found = new Set(retrieved)
  for (const id of query.forbid ?? []) {
    if (found.has(id)) errors.push(`retrieved forbidden thought "${id}"`)
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
    metrics: averageMetrics(queries.map(query => query.metrics)),
    queries,
    checkErrors
  }
}

export async function runEval(options: RunOptions = {}): Promise<RunResult> {
  const mode = options.mode ?? 'deterministic'
  const topK = options.topK ?? DEFAULT_TOP_K
  const scenarios = options.scenarios ?? EVAL_SCENARIOS
  const dir = mkdtempSync(join(tmpdir(), 'synaptomind-eval-'))
  const embed = mode === 'real' ? await realEmbedder() : deterministicEmbedder()
  const results: ScenarioRun[] = []

  try {
    for (const scenario of scenarios) {
      const safeName = scenario.name.replace(/[^a-zA-Z0-9-]/g, '_')
      closeDb()
      initDb({ dbPath: join(dir, `${safeName}.db`), runMigrations: true })
      const db = getDb()
      await seedScenario(db, scenario, embed)
      const searcher = mode === 'real' ? await realSearcher() : createDeterministicSearcher(db)

      const queries: QueryRun[] = []
      for (const query of scenario.queries) {
        const k = query.topK ?? topK
        const found = await searcher(query.query, k, query.projectFilter)
        const retrieved = found.map(result => result.thought.id)
        const checkErrors = evaluateChecks(query, retrieved)
        queries.push({
          query: query.query,
          relevant: query.relevant,
          metrics: computeQueryMetrics(retrieved, query.relevant, checkErrors)
        })
      }
      results.push(summariseScenario(scenario, queries))
    }
  } finally {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  }

  // xfail scenarios are reported but excluded from aggregate gating.
  const passScenarios = results.filter(scenario => scenario.outcome === 'pass')
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
    categories
  }
}

// ── Baseline / thresholds ────────────────────────────────────────────────────

export const METRIC_KEYS = ['recall', 'precision', 'mrr', 'hitRate'] as const
export type MetricKey = (typeof METRIC_KEYS)[number]
export type MetricFloor = Record<MetricKey, number>

export interface ThresholdEntry {
  generatedAt: string
  mode: EvalMode
  baseline: {
    overall: AggregateMetrics
    categories: Record<string, AggregateMetrics>
  }
  thresholds: {
    overall: MetricFloor
    categories: Record<string, MetricFloor>
  }
}

/** Thresholds are keyed by mode: deterministic and real baselines differ. */
export interface ThresholdFile {
  version: 1
  modes: Partial<Record<EvalMode, ThresholdEntry>>
}

const TOLERANCE = 1e-6
const DEFAULT_MARGIN = 0.02

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

function floorValue(value: number, margin: number): number {
  return Math.max(0, round4(value - margin))
}

function roundMetrics(metrics: AggregateMetrics): AggregateMetrics {
  return {
    recall: round4(metrics.recall),
    precision: round4(metrics.precision),
    mrr: round4(metrics.mrr),
    hitRate: round4(metrics.hitRate),
    queries: metrics.queries
  }
}

function floorOf(metrics: AggregateMetrics, margin: number): MetricFloor {
  return {
    recall: floorValue(metrics.recall, margin),
    precision: floorValue(metrics.precision, margin),
    mrr: floorValue(metrics.mrr, margin),
    hitRate: floorValue(metrics.hitRate, margin)
  }
}

export function buildThresholdEntry(result: RunResult, margin = DEFAULT_MARGIN): ThresholdEntry {
  const categories: Record<string, MetricFloor> = {}
  const baselineCategories: Record<string, AggregateMetrics> = {}
  for (const [category, metrics] of Object.entries(result.categories)) {
    categories[category] = floorOf(metrics, margin)
    baselineCategories[category] = roundMetrics(metrics)
  }
  return {
    generatedAt: new Date().toISOString(),
    mode: result.mode,
    baseline: { overall: roundMetrics(result.overall), categories: baselineCategories },
    thresholds: { overall: floorOf(result.overall, margin), categories }
  }
}

export function upsertThresholdEntry(file: ThresholdFile, entry: ThresholdEntry): ThresholdFile {
  return { version: 1, modes: { ...file.modes, [entry.mode]: entry } }
}

export function loadThresholds(path: string): ThresholdFile | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ThresholdFile
  } catch {
    return null
  }
}

export function writeThresholds(path: string, file: ThresholdFile): void {
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
}

function compareScope(
  scope: string,
  actual: AggregateMetrics,
  floor: MetricFloor,
  out: Regression[]
): void {
  for (const key of METRIC_KEYS) {
    if (actual[key] + TOLERANCE < floor[key]) {
      out.push({
        scope,
        metric: key,
        actual: round4(actual[key]),
        threshold: floor[key]
      })
    }
  }
}

/**
 * Hard scenario assertion failures. These gate the run independently of any
 * baseline: a failing non-xfail assertion is always a regression. xfail/xpass
 * scenarios never gate (their `status` is not `fail`).
 */
export function evaluateAssertions(result: RunResult): Regression[] {
  const regressions: Regression[] = []
  for (const scenario of result.scenarios) {
    if (scenario.status !== 'fail') continue
    for (const error of scenario.checkErrors) {
      regressions.push({
        scope: `scenario:${scenario.name}`,
        metric: 'assertion',
        actual: 0,
        threshold: 1,
        detail: error
      })
    }
  }
  return regressions
}

/**
 * Metric regressions against a recorded baseline. Unlike assertions these only
 * apply when a threshold entry exists for the current mode.
 */
export function evaluateThresholds(result: RunResult, entry: ThresholdEntry): Regression[] {
  const regressions: Regression[] = []
  compareScope('overall', result.overall, entry.thresholds.overall, regressions)

  for (const [category, floor] of Object.entries(entry.thresholds.categories)) {
    const actual = result.categories[category]
    if (!actual) {
      regressions.push({
        scope: `category:${category}`,
        metric: 'present',
        actual: 0,
        threshold: 1,
        detail: 'category has no passing scenarios'
      })
      continue
    }
    compareScope(`category:${category}`, actual, floor, regressions)
  }

  return regressions
}

/**
 * Regressions that gate `bun run eval`: hard assertions always, metric
 * regressions only when a baseline entry exists for the current mode.
 */
export function collectGatingRegressions(
  result: RunResult,
  entry: ThresholdEntry | null
): Regression[] {
  const regressions = evaluateAssertions(result)
  if (entry) regressions.push(...evaluateThresholds(result, entry))
  return regressions
}
