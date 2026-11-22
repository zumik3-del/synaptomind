import type { Database } from 'bun:sqlite'
import { z } from 'zod/v4'

export const SEVERITIES = ['critical', 'warning', 'info'] as const

export const severitySchema = z.enum(SEVERITIES)

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

export interface HealthSummary {
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
  score_breakdown: ScoreBreakdown
}

export interface HealthReport {
  summary: HealthSummary
  categories: CategoryResult[]
}

export interface HealthCheckOptions {
  severity?: Severity
}

export interface HealthViewOptions extends HealthCheckOptions {
  details?: boolean
  contentLimit?: number
}

export interface CheckView {
  name: string
  severity: Severity
  count: number
  auto_fixable?: boolean
  details?: unknown[]
}

export interface CategoryView {
  name: string
  checks: CheckView[]
}

export interface HealthView {
  summary: HealthSummary
  categories: CategoryView[]
}
