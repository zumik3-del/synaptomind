import type { Database } from 'bun:sqlite'

export const SEVERITIES = ['critical', 'warning', 'info'] as const

export type Severity = (typeof SEVERITIES)[number]

export type Autofix = (db: Database, details: unknown[]) => number | undefined

export interface CheckResult {
  name: string
  severity: Severity
  count: number
  details: unknown[]
  auto_fixable?: boolean
  autofix?: Autofix
}

export interface CategoryResult {
  name: string
  checks: CheckResult[]
}

export interface CheckDef {
  name: string
  severity: Severity
  finder: (db: Database) => unknown[]
  autofix?: Autofix
}

export interface ScoreBreakdown {
  critical_categories: number
  warning_categories: number
  info_occurrences: number
  info_scored_occurrences: number
  info_unscored_checks: string[]
  penalty_critical: number
  penalty_warning: number
  penalty_info: number
  formula: string
}

export interface HealthReport {
  summary: {
    total_thoughts: number
    total_edges: number
    total_clusters: number
    active: number
    draft: number
    archived: number
    health_score: number
    critical: number
    warning: number
    info: number
    critical_count: number
    warning_count: number
    info_count: number
    critical_issues: number
    warning_issues: number
    info_issues: number
    issues: { critical: number; warning: number; info: number }
    score_breakdown: ScoreBreakdown
    score_composition: ScoreBreakdown
    score_explanation: ScoreBreakdown
    score_components: ScoreBreakdown
    score_details: ScoreBreakdown
    score_formula: string
    formula: string
  }
  categories: CategoryResult[]
}

export interface HealthCheckOptions {
  severity?: Severity
}
