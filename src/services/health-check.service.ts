import { getDb } from '../db'
import { getGraphStats } from '../db/health-check'
import type { Database } from 'bun:sqlite'
import { CATEGORIES, runChecks } from './health-check-registry.service'
import { scoreCategories } from './health-check-scoring.service'
import {
  SEVERITIES,
  type CategoryResult,
  type CheckResult,
  type HealthCheckOptions,
  type HealthReport,
  type Severity
} from './health-check.types'

export { SEVERITIES }
export type { CategoryResult, CheckResult, HealthReport, Severity }

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 }

function matchesSeverity(check: CheckResult, minSeverity?: Severity): boolean {
  if (!minSeverity) return true
  return SEVERITY_ORDER[check.severity] <= SEVERITY_ORDER[minSeverity]
}

export function runHealthCheckService(
  options: HealthCheckOptions = {},
  d: Database = getDb()
): HealthReport {
  const stats = getGraphStats(d)

  let categories: CategoryResult[] = CATEGORIES.map(({ name, checks }) => ({
    name,
    checks: runChecks(d, checks)
  }))

  if (options.severity) {
    categories = categories
      .map(c => ({ ...c, checks: c.checks.filter(ch => matchesSeverity(ch, options.severity)) }))
      .filter(c => c.checks.length > 0)
  }

  const score = scoreCategories(categories)

  return {
    summary: {
      ...stats,
      health_score: score.health_score,
      critical: score.critical,
      warning: score.warning,
      info: score.info,
      critical_count: score.critical,
      warning_count: score.warning,
      info_count: score.info,
      critical_issues: score.critical,
      warning_issues: score.warning,
      info_issues: score.info,
      issues: { critical: score.critical, warning: score.warning, info: score.info },
      score_breakdown: score.breakdown,
      score_composition: score.breakdown,
      score_explanation: score.breakdown,
      score_components: score.breakdown,
      score_details: score.breakdown,
      score_formula: score.breakdown.formula,
      formula: score.breakdown.formula
    },
    categories
  }
}

export type { HealthRepairResult } from './health-check-repair.service'
