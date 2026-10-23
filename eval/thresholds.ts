// Baseline and threshold file management for the eval runner.

import { readFileSync, writeFileSync } from 'node:fs'
import type { AggregateMetrics } from './types'
import type { EvalMode, Regression, RunResult } from './types'

const METRIC_KEYS = ['recall', 'precision', 'mrr', 'hitRate'] as const
type MetricKey = (typeof METRIC_KEYS)[number]
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
