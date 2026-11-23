import { getDb } from '../db'
import { getGraphStats } from '../db/health-check'
import type { Database } from 'bun:sqlite'
import { CATEGORIES, runChecks } from './health-check-registry.service'
import { scoreCategories } from './health-check-scoring.service'
import {
  SEVERITIES,
  severitySchema,
  type CategoryResult,
  type CategoryView,
  type CheckResult,
  type CheckView,
  type HealthCheckOptions,
  type HealthReport,
  type HealthView,
  type HealthViewOptions,
  type Severity
} from './health-check.types'

export { SEVERITIES, severitySchema }
export type { CategoryResult, CheckResult, HealthReport, HealthView, HealthViewOptions, Severity }

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 }

const TRUNCATION_MARKER = '…'

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
      score_breakdown: score.breakdown
    },
    categories
  }
}

function truncateContent(value: string, contentLimit: number | undefined): string {
  if (contentLimit === undefined || value.length <= contentLimit) return value
  return `${value.slice(0, contentLimit)}${TRUNCATION_MARKER}`
}

// A shortened content value carries the marker, so a caller can tell a cut string from a short one.
function viewDetail(value: unknown, contentLimit: number | undefined): unknown {
  if (Array.isArray(value)) return value.map(entry => viewDetail(entry, contentLimit))
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && key.toLowerCase().includes('content')) {
      out[key] = truncateContent(entry, contentLimit)
    } else if (entry !== null && typeof entry === 'object') {
      out[key] = viewDetail(entry, contentLimit)
    } else {
      out[key] = entry
    }
  }
  return out
}

// The one wire shape of a health report: MCP and HTTP both build on it. `details` adds the
// per-check findings (content strings cut at `contentLimit`), and the repair hooks never leave
// the service layer.
export function runHealthCheckView(
  options: HealthViewOptions = {},
  d: Database = getDb()
): HealthView {
  const report = runHealthCheckService({ severity: options.severity }, d)
  const categories: CategoryView[] = report.categories.map(cat => ({
    name: cat.name,
    checks: cat.checks.map(check => {
      const view: CheckView = {
        name: check.name,
        severity: check.severity,
        count: check.count
      }
      if (check.auto_fixable !== undefined) view.auto_fixable = check.auto_fixable
      if (options.details === true) {
        view.details = check.details.map(detail => viewDetail(detail, options.contentLimit))
      }
      return view
    })
  }))
  return { summary: report.summary, categories }
}
